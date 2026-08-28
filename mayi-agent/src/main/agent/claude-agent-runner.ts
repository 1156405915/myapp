import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import type { AgentActivity, ChatSession, TokenUsage } from '../../shared/protocol'

interface RuntimeConfig {
  apiKey: string
  model: string
  cwd: string
}

interface RunCallbacks {
  onDelta(delta: string): void
  onActivity(activity: AgentActivity): void
}

export interface AgentRunResult {
  content: string
  runtimeSessionId: string
  model?: string
  tokenUsage?: TokenUsage
}

const ENABLED_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Skill']
const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'

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

  async run(
    session: ChatSession,
    prompt: string,
    config: RuntimeConfig,
    callbacks: RunCallbacks
  ): Promise<AgentRunResult> {
    if (!config.apiKey) {
      throw new Error('请先在设置中配置 DeepSeek API Key')
    }

    const abortController = new AbortController()
    this.controllers.set(session.id, abortController)

    let runtimeSessionId = session.runtimeSessionId || ''
    let finalContent = ''
    let model: string | undefined
    let tokenUsage: TokenUsage | undefined
    const runtimeModel = config.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro[1m]' : config.model
    const proxyUrl = getProxyUrl()
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
          permissionMode: 'dontAsk',
          tools: ENABLED_TOOLS,
          allowedTools: ENABLED_TOOLS,
          skills: 'all',
          settingSources: [],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append:
              '你是蚂蚁企业级 AI 协作助手。默认使用中文，回答准确简洁；执行文件修改前先理解现有代码，完成后说明修改结果。'
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
            ...(proxyUrl
              ? {
                  HTTP_PROXY: proxyUrl,
                  HTTPS_PROXY: proxyUrl,
                  http_proxy: proxyUrl,
                  https_proxy: proxyUrl
                }
              : {})
          },
          stderr: (data) => console.error('[DeepSeekAgent]', data)
        }
      })

      for await (const message of stream) {
        runtimeSessionId = this.readSessionId(message) || runtimeSessionId
        this.handleStreamMessage(message, callbacks)
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
      }

      if (!runtimeSessionId) throw new Error('DeepSeek Agent 未返回会话 ID')
      if (!finalContent.trim()) finalContent = '任务已完成。'

      return { content: finalContent, runtimeSessionId, model, tokenUsage }
    } finally {
      this.controllers.delete(session.id)
    }
  }

  cancel(sessionId: string): void {
    this.controllers.get(sessionId)?.abort()
  }

  private readSessionId(message: SDKMessage): string | undefined {
    return 'session_id' in message && typeof message.session_id === 'string'
      ? message.session_id
      : undefined
  }

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
      callbacks.onActivity({
        kind: 'tool',
        label: `正在执行 ${message.tool_name}`,
        toolName: message.tool_name
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
}
