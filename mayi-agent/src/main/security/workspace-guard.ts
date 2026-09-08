import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve } from 'node:path'

export interface SecurityValidation {
  allowed: boolean
  reason?: string
  blockedPath?: string
  risk?: 'low' | 'medium' | 'high'
}

const FILE_PATH_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  Glob: ['path'],
  Grep: ['path']
}

const FILTER_FIELDS: Record<string, string[]> = {
  Glob: ['pattern'],
  Grep: ['glob']
}

const READ_ONLY_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep'])

const COMMAND_PREFIX = String.raw`(?:^|[;&|]\s*|\r?\n\s*)(?:sudo\s+)?`

function commandPattern(commandNames: string, suffix = String.raw`(?=\s|$)`): RegExp {
  return new RegExp(`${COMMAND_PREFIX}(?:${commandNames})${suffix}`, 'i')
}

const HIGH_RISK_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: commandPattern('format|diskpart|bcdedit'), reason: '禁止执行磁盘或启动配置命令' },
  { pattern: commandPattern('shutdown|restart-computer|stop-computer'), reason: '禁止执行关机或重启命令' },
  { pattern: /\brm\s+(?:-[^\r\n]*r[^\r\n]*f|-[^\r\n]*f[^\r\n]*r)\s+(?:\/|~|\$HOME)(?:\s|$)/i, reason: '禁止递归删除根目录或用户目录' },
  { pattern: /\bremove-item\b[^\r\n]*(?:-recurse[^\r\n]*-force|-force[^\r\n]*-recurse)/i, reason: '禁止强制递归删除' },
  { pattern: /\b(?:del|erase)\b[^\r\n]*\/s[^\r\n]*\/q/i, reason: '禁止静默递归删除' },
  { pattern: commandPattern('mkfs|fdisk|parted|dd'), reason: '禁止修改磁盘分区或设备' },
  { pattern: commandPattern('reg(?:\\.exe)?', String.raw`\s+(?:add|delete)\s+HKLM\\`), reason: '禁止修改系统级注册表' },
  { pattern: commandPattern('net', String.raw`\s+(?:user|localgroup)\b`), reason: '禁止修改系统用户或用户组' },
  { pattern: commandPattern('sc(?:\\.exe)?', String.raw`\s+(?:create|delete|config)\b`), reason: '禁止修改系统服务' },
  { pattern: commandPattern('schtasks(?:\\.exe)?', String.raw`\s+\/(?:create|delete|change)\b`), reason: '禁止修改系统计划任务' },
  { pattern: commandPattern('set-executionpolicy'), reason: '禁止修改 PowerShell 执行策略' },
  { pattern: commandPattern('invoke-expression|iex|eval'), reason: '禁止执行动态拼接命令' },
  { pattern: commandPattern('powershell|pwsh', String.raw`[^\r\n]*(?:-enc|-encodedcommand)\b`), reason: '禁止执行编码隐藏的 PowerShell 命令' },
  { pattern: /\b(?:curl|wget|invoke-webrequest|iwr)\b[^|\r\n]*\|\s*(?:bash|sh|zsh|powershell|pwsh|iex)\b/i, reason: '禁止下载后直接执行远程脚本' },
  { pattern: /(?:^|[\s"'])\.\.(?:[\\/]|$)/, reason: '禁止命令通过父目录离开工作区' },
  { pattern: /(?:%USERPROFILE%|%HOMEDRIVE%|%WINDIR%|%SYSTEMROOT%|\$HOME\b|\$\{HOME\}|\$env:(?:USERPROFILE|WINDIR|SYSTEMROOT)\b|~[\\/])/i, reason: '禁止通过系统目录变量绕过工作区边界' },
  { pattern: /(?:^|[\s"'])(?:\/(?:etc|var|root|home|mnt|proc|sys|dev|usr|bin|sbin|opt|tmp)(?:\/|\s|$))/i, reason: '禁止访问宿主或 Linux 系统目录' }
]

const WINDOWS_PROTECTED_ROOTS = [
  process.env.SystemRoot,
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  process.env.ProgramData
].filter((value): value is string => Boolean(value))

/** 使用平台对应的大小写规则比较两个绝对路径。 */
function normalizeForComparison(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

/** 判断目标路径是否等于根目录或位于根目录内部。 */
function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const root = normalizeForComparison(rootPath)
  const target = normalizeForComparison(targetPath)
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

/** 为尚未创建的写入目标找到最近的真实父目录。 */
function findNearestExistingPath(targetPath: string): string {
  let current = targetPath
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

/** 校验只读目标位于应用显式提供的可信资源根目录内。 */
function validateTrustedReadPath(
  workspacePath: string,
  requestedPath: string,
  trustedRoot: string
): SecurityValidation {
  if (!trustedRoot || !existsSync(trustedRoot) || !statSync(trustedRoot).isDirectory()) {
    return { allowed: false }
  }
  if (/^(?:\\\\|\/\/)/.test(requestedPath)) return { allowed: false }

  const realRoot = realpathSync(resolve(trustedRoot))
  const targetPath = resolve(workspacePath, requestedPath)
  if (!existsSync(targetPath)) return { allowed: false }

  const realTarget = realpathSync(targetPath)
  return isWithinRoot(realRoot, realTarget) ? { allowed: true } : { allowed: false }
}

/** 拒绝驱动器根目录和操作系统关键目录作为 Agent 工作区。 */
export function validateWorkspaceRoot(workspacePath: string): SecurityValidation {
  if (!workspacePath || workspacePath.includes('\0')) {
    return { allowed: false, reason: '工作目录无效', blockedPath: workspacePath }
  }

  const resolvedWorkspace = resolve(workspacePath)
  if (!existsSync(resolvedWorkspace) || !statSync(resolvedWorkspace).isDirectory()) {
    return { allowed: false, reason: '工作目录不存在或不是文件夹', blockedPath: resolvedWorkspace }
  }

  const realWorkspace = realpathSync(resolvedWorkspace)
  if (normalizeForComparison(realWorkspace) === normalizeForComparison(parse(realWorkspace).root)) {
    return { allowed: false, reason: '不允许将磁盘根目录设置为工作区', blockedPath: realWorkspace }
  }

  if (WINDOWS_PROTECTED_ROOTS.some((protectedRoot) => isWithinRoot(protectedRoot, realWorkspace))) {
    return { allowed: false, reason: '不允许将系统目录设置为工作区', blockedPath: realWorkspace }
  }

  return { allowed: true }
}

/** 同时执行词法包含检查和真实路径检查，防止符号链接逃逸。 */
export function validateWorkspacePath(
  workspacePath: string,
  requestedPath: string,
  allowMissingTarget = false
): SecurityValidation {
  const workspaceValidation = validateWorkspaceRoot(workspacePath)
  if (!workspaceValidation.allowed) return workspaceValidation
  if (!requestedPath || requestedPath.includes('\0')) {
    return { allowed: false, reason: '目标路径无效', blockedPath: requestedPath }
  }
  if (/^(?:\\\\|\/\/)/.test(requestedPath)) {
    return { allowed: false, reason: '不允许访问 UNC 网络路径', blockedPath: requestedPath }
  }

  const realWorkspace = realpathSync(resolve(workspacePath))
  const targetPath = resolve(realWorkspace, requestedPath)
  if (!isWithinRoot(realWorkspace, targetPath)) {
    return { allowed: false, reason: '目标路径超出当前工作区', blockedPath: targetPath }
  }

  if (!existsSync(targetPath) && !allowMissingTarget) {
    return { allowed: false, reason: '目标路径不存在', blockedPath: targetPath }
  }

  const existingPath = allowMissingTarget ? findNearestExistingPath(targetPath) : targetPath
  const realExistingPath = realpathSync(existingPath)
  if (!isWithinRoot(realWorkspace, realExistingPath)) {
    return { allowed: false, reason: '检测到符号链接或目录连接逃逸', blockedPath: targetPath }
  }

  return { allowed: true }
}

/** 阻止 Glob 和 Grep 过滤表达式借助父目录或绝对路径越界。 */
function validateFilterPattern(value: unknown): SecurityValidation {
  if (value === undefined) return { allowed: true }
  if (typeof value !== 'string' || value.includes('\0')) {
    return { allowed: false, reason: '文件匹配表达式无效' }
  }
  if (isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) {
    return { allowed: false, reason: '文件匹配表达式不能离开工作区', blockedPath: value }
  }
  return { allowed: true }
}

/** 从命令中提取明确的绝对路径和 cd 目标用于边界检查。 */
function extractCommandPaths(command: string): string[] {
  const paths = new Set<string>()
  const windowsPaths = command.match(/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s"'`;|&<>]*/g) || []
  const uncPaths = command.match(/\\\\[^\s"'`;|&<>]+/g) || []
  for (const value of [...windowsPaths, ...uncPaths]) paths.add(value)

  const cdPattern = /(?:^|[;&|]\s*)cd(?:\s+\/d)?\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi
  for (const match of command.matchAll(cdPattern)) {
    paths.add(match[1] || match[2] || match[3])
  }
  return [...paths]
}

/** 移除 heredoc 正文，避免其中的程序源码被当作 Shell 命令。 */
function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/)
  const kept: string[] = []
  let delimiter: string | undefined
  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined
      continue
    }
    kept.push(line)
    const match = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/)
    delimiter = match?.[1] || match?.[2] || match?.[3]
  }
  return kept.join('\n')
}

/** 将 Git Bash 的 /d/path 转为 Windows 驱动器绝对路径。 */
function normalizeCommandPath(value: string): string {
  if (process.platform !== 'win32') return value
  const match = value.match(/^\/([A-Za-z])(?:\/(.*))?$/)
  return match ? `${match[1].toUpperCase()}:/${match[2] || ''}` : value
}

/** 对 Bash 命令执行高风险规则和可识别路径的工作区检查。 */
export function validateBashCommand(workspacePath: string, command: unknown): SecurityValidation {
  if (typeof command !== 'string' || !command.trim() || command.length > 100_000 || command.includes('\0')) {
    return { allowed: false, reason: '终端命令无效', risk: 'high' }
  }

  const shellCommands = stripHeredocBodies(command)
  for (const rule of HIGH_RISK_COMMANDS) {
    if (rule.pattern.test(shellCommands)) return { allowed: false, reason: rule.reason, risk: 'high' }
  }

  for (const commandPath of extractCommandPaths(shellCommands)) {
    const validation = validateWorkspacePath(workspacePath, normalizeCommandPath(commandPath), true)
    if (!validation.allowed) return { ...validation, risk: 'high' }
  }

  return { allowed: true, risk: 'medium' }
}

/** 根据 SDK 工具输入统一执行文件路径和命令安全检查。 */
export function validateToolUse(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
  readOnlyRoots: string[] = []
): SecurityValidation {
  if (toolName === 'Bash') return validateBashCommand(workspacePath, input.command)

  for (const field of FILE_PATH_FIELDS[toolName] || []) {
    const value = input[field]
    if (value === undefined && (toolName === 'Glob' || toolName === 'Grep')) continue
    if (typeof value !== 'string') return { allowed: false, reason: `${toolName} 缺少有效路径` }
    const validation = validateWorkspacePath(workspacePath, value, toolName === 'Write')
    if (!validation.allowed) {
      const trustedRead = READ_ONLY_FILE_TOOLS.has(toolName) && readOnlyRoots.some((root) =>
        validateTrustedReadPath(workspacePath, value, root).allowed
      )
      if (!trustedRead) return validation
    }
  }

  for (const field of FILTER_FIELDS[toolName] || []) {
    const validation = validateFilterPattern(input[field])
    if (!validation.allowed) return validation
  }

  return { allowed: true, risk: toolName === 'Write' || toolName === 'Edit' ? 'medium' : 'low' }
}
