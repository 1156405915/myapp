import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface LogContext {
  sessionId?: string
  traceId?: string
  module?: string
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR'

const storage = new AsyncLocalStorage<LogContext>()
const MAX_LOG_SIZE = 5 * 1024 * 1024
const MAX_LOG_FILES = 5
const MAX_VALUE_LENGTH = 4_000
const SENSITIVE_KEY = /(?:api[-_]?key|token|authorization|password|secret|cookie)/i

/** 在异步调用链中传播会话、Trace 和模块信息。 */
export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return storage.run(context, callback)
}

/** 为一次 Agent 执行生成便于关联日志的短 Trace ID。 */
export function createTraceId(): string {
  return randomUUID().slice(0, 12)
}

/** 返回日志目录，并兼容测试环境中 Electron 尚未初始化的情况。 */
export function getLogDirectory(): string {
  const override = process.env.MAYI_USER_DATA_DIR
  if (override) return join(override, 'logs')
  try {
    return join(app.getPath('userData'), 'logs')
  } catch {
    return join(process.cwd(), '.mayi-user-data', 'logs')
  }
}

/** 截断可能异常膨胀的日志字段。 */
function truncate(value: string): string {
  return value.length <= MAX_VALUE_LENGTH
    ? value
    : `${value.slice(0, MAX_VALUE_LENGTH)}…[truncated ${value.length - MAX_VALUE_LENGTH} chars]`
}

/** 递归清理凭据字段，并限制复杂对象的日志体积。 */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return truncate(
      value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    )
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return value
  }
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message), stack: value.stack && truncate(value.stack) }
  }
  if (depth >= 4) return '[MAX_DEPTH]'
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1, seen)])
    return Object.fromEntries(entries)
  }
  return String(value)
}

/** 轮转超出大小限制的活动日志，并清理最旧文件。 */
function rotateLogs(logDirectory: string, logPath: string): void {
  if (existsSync(logPath) && statSync(logPath).size >= MAX_LOG_SIZE) {
    const rotatedPath = join(logDirectory, `mayi-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    renameSync(logPath, rotatedPath)
  }

  const files = readdirSync(logDirectory)
    .filter((name) => name.startsWith('mayi-') && name.endsWith('.log'))
    .map((name) => ({ name, modifiedAt: statSync(join(logDirectory, name)).mtimeMs }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)

  for (const file of files.slice(MAX_LOG_FILES - 1)) {
    unlinkSync(join(logDirectory, file.name))
  }
}

/** 将结构化日志写入控制台和用户数据目录，写入失败不影响主业务。 */
function writeLog(level: LogLevel, message: string, metadata?: unknown): void {
  const context = storage.getStore() || {}
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: context.module,
    sessionId: context.sessionId,
    traceId: context.traceId,
    message: truncate(message),
    metadata: metadata === undefined ? undefined : sanitize(metadata)
  }
  const line = `${JSON.stringify(entry)}\n`

  if (level === 'ERROR') console.error(message, metadata ?? '')
  else if (level === 'WARN') console.warn(message, metadata ?? '')
  else console.info(message, metadata ?? '')

  try {
    const logDirectory = getLogDirectory()
    mkdirSync(logDirectory, { recursive: true })
    const logPath = join(logDirectory, 'mayi-current.log')
    rotateLogs(logDirectory, logPath)
    appendFileSync(logPath, line, 'utf8')
  } catch (error) {
    console.error('[MayiLogger] 日志写入失败', error)
  }
}

/** 写入普通运行信息。 */
export function logInfo(message: string, metadata?: unknown): void {
  writeLog('INFO', message, metadata)
}

/** 写入需要关注但未中断任务的异常状态。 */
export function logWarn(message: string, metadata?: unknown): void {
  writeLog('WARN', message, metadata)
}

/** 写入导致操作失败的错误。 */
export function logError(message: string, metadata?: unknown): void {
  writeLog('ERROR', message, metadata)
}
