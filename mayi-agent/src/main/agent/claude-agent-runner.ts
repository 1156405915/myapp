import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentActivity,
  ChatSession,
  ContentBlock,
  ContextUsage,
  PermissionDecision,
  PermissionRequest,
  TokenUsage
} from '../../shared/protocol'
import { logError, logInfo, logWarn } from '../logging/logger'
import { validateToolUse, validateWorkspaceRoot } from '../security/workspace-guard'

interface RuntimeConfig {
  apiKey: string
  model: string
  cwd: string
}

interface RunCallbacks {
  onDelta(delta: string): void
  onActivity(activity: AgentActivity): void
  onPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>
}

export interface AgentRunResult {
  blocks: ContentBlock[]
  runtimeSessionId: string
  model?: string
  tokenUsage?: TokenUsage
  contextUsage?: ContextUsage
  durationMs?: number
}

const ENABLED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
  'Skill'
]
const AUTO_ALLOWED_TOOLS = ['WebSearch', 'WebFetch', 'Skill']
const GUARDED_READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
const moduleDirectory = dirname(fileURLToPath(import.meta.url))

/** 解析开发态或安装包内的文档技能插件，并在资源损坏时提前终止。 */
function getDocumentSkillsPluginPath(): string {
  const pluginPath = app.isPackaged
    ? join(process.resourcesPath, 'skills-plugin')
    : resolve(moduleDirectory, '../../resources/skills-plugin')
  const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifestPath)) throw new Error(`文档技能资源缺失：${manifestPath}`)
  return pluginPath
}

/** 优先使用进程代理，并兼容读取 Windows 当前用户的系统代理。 */
function getProxyUrl(): string | undefined {
  const environmentProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (environmentProxy) return environmentProxy
  if (process.platform !== 'win32') return undefined

  try {
    const output = execFileSync(
      'reg.exe',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer'
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    const rawProxy = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim()
    if (!rawProxy) return undefined

    const entries = rawProxy.split(';').map((entry) => entry.trim())
    const httpsProxy = entries.find((entry) => entry.toLowerCase().startsWith('https='))
    const proxyAddress = httpsProxy?.slice(6) || entries.find((entry) => !entry.includes('='))
    if (!proxyAddress) return undefined
    return /^https?:\/\//i.test(proxyAddress) ? proxyAddress : `http://${proxyAddress}`
  } catch {
    return undefined
  }
}

export class ClaudeAgentRunner {
  private readonly controllers = new Map<string, AbortController>()
  private readonly sessionAllowedTools = new Map<string, Set<string>>()

  /** 启动可恢复的 Agent 流式任务，并汇总最终回复和用量。 */
  async run(
    session: ChatSession,
    prompt: string,
    config: RuntimeConfig,
    callbacks: RunCallbacks
  ): Promise<AgentRunResult> {
    if (!config.apiKey) {
      throw new Error('请先在设置中配置 DeepSeek API Key')
    }
    const workspaceValidation = validateWorkspaceRoot(config.cwd)
    if (!workspaceValidation.allowed) {
      throw new Error(workspaceValidation.reason || 'Agent 工作目录无效')
    }

    const abortController = new AbortController()
    this.controllers.set(session.id, abortController)

    let runtimeSessionId = session.runtimeSessionId || ''
    let finalContent = ''
    const blocks: ContentBlock[] = []
    let model: string | undefined
    let tokenUsage: TokenUsage | undefined
    let contextUsage: ContextUsage | undefined
    let durationMs: number | undefined
    // Pro 模型使用服务端长上下文别名，界面仍保留用户选择的标准名称。
    const runtimeModel = config.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro[1m]' : config.model
    const proxyUrl = getProxyUrl()
    const documentSkillsPluginPath = getDocumentSkillsPluginPath()
    logInfo('Agent 任务开始', { model: runtimeModel, cwd: config.cwd, resumed: Boolean(session.runtimeSessionId) })
    try {
      const stream = query({
        prompt,
        options: {
          abortController,
          cwd: config.cwd,
          model: runtimeModel,
          resume: session.runtimeSessionId,
          persistSession: true,
          includePartialMessages: true,
          maxTurns: 30,
          permissionMode: 'default',
          tools: ENABLED_TOOLS,
          allowedTools: AUTO_ALLOWED_TOOLS,
          canUseTool: async (toolName, input, options) => {
            const toolInput = input as Record<string, unknown>
            const security = validateToolUse(toolName, toolInput, config.cwd)
            if (!security.allowed) {
              logWarn('工具调用被安全策略拒绝', {
                toolName,
                reason: security.reason,
                blockedPath: security.blockedPath,
                risk: security.risk
              })
              return {
                behavior: 'deny',
                message: security.reason || '工具调用违反工作区安全策略',
                toolUseID: options.toolUseID
              }
            }

            if (GUARDED_READ_TOOLS.has(toolName)) {
              logInfo('只读工具通过工作区路径检查', { toolName })
              return { behavior: 'allow', toolUseID: options.toolUseID }
            }

            if (this.sessionAllowedTools.get(session.id)?.has(toolName)) {
              logInfo('工具通过本会话授权规则', { toolName })
              return { behavior: 'allow', toolUseID: options.toolUseID }
            }

            const decision = await callbacks.onPermission(
              {
                sessionId: session.id,
                toolUseId: options.toolUseID,
                toolName,
                input: toolInput,
                title: options.title,
                displayName: options.displayName,
                description: options.description,
                decisionReason: options.decisionReason,
                blockedPath: security.blockedPath || options.blockedPath,
                canAlwaysAllow:
                  Boolean(options.suggestions?.length) ||
                  ['Bash', 'Write', 'Edit'].includes(toolName)
              },
              options.signal
            )

            logInfo('工具权限已决策', { toolName, decision, risk: security.risk })

            if (decision === 'deny') {
              return {
                behavior: 'deny',
                message: '用户拒绝执行该工具',
                toolUseID: options.toolUseID
              }
            }

            if (decision === 'allow-always') {
              const allowedTools = this.sessionAllowedTools.get(session.id) || new Set<string>()
              allowedTools.add(toolName)
              this.sessionAllowedTools.set(session.id, allowedTools)
            }

            return {
              behavior: 'allow',
              toolUseID: options.toolUseID
            }
          },
          plugins: [
            {
              type: 'local',
              path: documentSkillsPluginPath,
              skipMcpDiscovery: true
            }
          ],
          // 白名单与禁用 MCP 自动发现共同保证安装包只加载内置办公技能。
          skills: ['pdf', 'docx', 'pptx', 'xlsx'],
          // 禁止用户目录或项目目录中的 Claude 配置改变应用安全策略。
          settingSources: [],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append:
              '你是蚂蚁企业级 AI 协作助手。默认使用中文，回答准确简洁；执行文件修改前先理解现有代码，完成后说明修改结果。' +
              '本地文件工具和 Bash 在当前会话固定的工作区中运行，禁止访问工作区之外的路径。' +
              '当任务涉及 PDF、DOCX、PPTX、XLSX、CSV 或其他办公文档时，必须先调用对应的内置 Skill，严格遵循技能中的完整工作流。' +
              '禁止用临时简陋脚本或 HTML 打印冒充用户要求的正式文件格式。生成表格时必须设置页面可用宽度、列宽、单元格换行、分页和重复表头。' +
              '交付前必须完成结构校验；PDF 必须逐页渲染检查，DOCX/PPTX 必须转换为 PDF 后逐页检查，XLSX 必须重算公式并确保零公式错误。' +
              '必须检查文字裁切、越界、重叠、乱码、空白页、表格溢出和打印区域。验证失败必须修复并重新生成；缺少验证依赖时不得声称文件已完成。'
          },
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
            ANTHROPIC_API_KEY: config.apiKey,
            ANTHROPIC_AUTH_TOKEN: config.apiKey,
            ANTHROPIC_MODEL: runtimeModel,
            ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModel,
            ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModel,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
            CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
            CLAUDE_CODE_EFFORT_LEVEL: 'max',
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
            CLAUDE_AGENT_SDK_CLIENT_APP: 'mayi-agent',
            MAYI_DOCUMENT_SKILLS_ROOT: join(documentSkillsPluginPath, 'skills'),
            ...(proxyUrl
              ? {
                  HTTP_PROXY: proxyUrl,
                  HTTPS_PROXY: proxyUrl,
                  http_proxy: proxyUrl,
                  https_proxy: proxyUrl
                }
              : {})
          },
          /** 将 SDK 子进程诊断写入可按会话检索的持久化日志。 */
          stderr: (data) => logWarn('Agent SDK 诊断输出', { data })
        }
      })

      for await (const message of stream) {
        // 任意流消息都可能最先携带后续恢复会话所需的 ID。
        runtimeSessionId = this.readSessionId(message) || runtimeSessionId
        this.handleStreamMessage(message, callbacks)
        contextUsage = this.collectContentBlocks(message, blocks) || contextUsage
        if (message.type !== 'result') continue

        if (message.subtype !== 'success') {
          throw new Error(message.errors.join('\n') || `Agent 执行失败：${message.subtype}`)
        }

        finalContent = message.result
        const firstModel = Object.entries(message.modelUsage)[0]
        model = firstModel?.[0]
        tokenUsage = {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          costUsd: message.total_cost_usd
        }
        durationMs = message.duration_ms
      }

      if (!runtimeSessionId) throw new Error('DeepSeek Agent 未返回会话 ID')
      if (!blocks.some((block) => block.type === 'text' && block.text.trim())) {
        blocks.push({ type: 'text', text: finalContent.trim() || '任务已完成。' })
      }

      logInfo('Agent 任务完成', { model, tokenUsage, durationMs })
      return { blocks, runtimeSessionId, model, tokenUsage, contextUsage, durationMs }
    } catch (error) {
      logError('Agent 任务失败', error)
      throw error
    } finally {
      this.controllers.delete(session.id)
    }
  }

  /** 中止指定会话当前正在执行的 SDK 请求。 */
  cancel(sessionId: string): void {
    logInfo('正在取消 Agent 任务', { sessionId })
    this.controllers.get(sessionId)?.abort()
  }

  /** 清理已删除会话关联的执行器和持续授权状态。 */
  forgetSession(sessionId: string): void {
    this.cancel(sessionId)
    this.sessionAllowedTools.delete(sessionId)
  }

  /** 从不同类型的 SDK 消息中安全提取可恢复会话 ID。 */
  private readSessionId(message: SDKMessage): string | undefined {
    return 'session_id' in message && typeof message.session_id === 'string'
      ? message.session_id
      : undefined
  }

  /** 将 SDK 流事件转换为界面可消费的文本增量和活动状态。 */
  private handleStreamMessage(message: SDKMessage, callbacks: RunCallbacks): void {
    if (message.type === 'system' && message.subtype === 'api_retry') {
      const retry = message as unknown as {
        attempt: number
        max_retries: number
        error_status: number | null
      }
      callbacks.onActivity({
        kind: 'thinking',
        label: `DeepSeek 服务器繁忙，正在重试 (${retry.attempt}/${retry.max_retries})`
      })
      return
    }

    if (message.type === 'tool_progress') {
      const toolName = message.tool_name
      callbacks.onActivity({
        kind: 'tool',
        label: `正在执行 ${toolName}`,
        toolName
      })
      return
    }

    if (message.type !== 'stream_event') return

    const event = message.event as {
      type?: string
      delta?: { type?: string; text?: string }
      content_block?: { type?: string; name?: string }
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      if (event.delta.text) callbacks.onDelta(event.delta.text)
      return
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      callbacks.onActivity({ kind: 'thinking', label: '正在思考' })
      return
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const toolName = event.content_block.name || '工具'
      callbacks.onActivity({ kind: 'tool', label: `正在执行 ${toolName}`, toolName })
    }
  }

  /** 从完整 SDK 消息中提取可恢复的结构化内容块和上下文使用量。 */
  private collectContentBlocks(message: SDKMessage, target: ContentBlock[]): ContextUsage | undefined {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          target.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && block.thinking) {
          target.push({ type: 'thinking', thinking: block.thinking })
        } else if (block.type === 'tool_use') {
          target.push({
            type: 'tool_use',
            toolUseId: block.id,
            toolName: block.name,
            input:
              block.input && typeof block.input === 'object'
                ? (block.input as Record<string, unknown>)
                : {}
          })
        }
      }
      return message.context_usage
        ? {
            usedTokens: message.context_usage.total_tokens,
            maxTokens: message.context_usage.raw_max_tokens
          }
        : undefined
    }

    if (message.type !== 'user' || typeof message.message.content === 'string') return undefined
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      target.push({
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content: this.stringifyToolResult(block.content ?? message.tool_use_result),
        isError: block.is_error
      })
    }
    return undefined
  }

  /** 将字符串或复杂工具输出转换为可持久化、可复制的稳定文本。 */
  private stringifyToolResult(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value ?? null, null, 2)
    } catch {
      return String(value)
    }
  }
}
