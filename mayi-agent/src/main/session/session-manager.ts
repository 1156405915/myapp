import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatSession,
  PermissionDecision,
  PermissionRequest,
  PermissionResponseInput,
  ServerEvent
} from '../../shared/protocol'
import { ClaudeAgentRunner } from '../agent/claude-agent-runner'
import { AppStore } from '../store/app-store'

interface QueuedPrompt {
  prompt: string
}

interface PendingPermission {
  sessionId: string
  resolve: (decision: PermissionDecision) => void
  timeout: ReturnType<typeof setTimeout>
  signal: AbortSignal
  abortListener: () => void
}

export class SessionManager {
  private readonly queues = new Map<string, QueuedPrompt[]>()
  private readonly activeSessions = new Set<string>()
  private readonly cancelledSessions = new Set<string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()

  /** 注入持久化、Agent 执行器和主进程事件出口。 */
  constructor(
    private readonly store: AppStore,
    private readonly runner: ClaudeAgentRunner,
    private readonly sendEvent: (event: ServerEvent) => void
  ) {}

  /** 返回按存储层规则排序的全部会话。 */
  listSessions(): ChatSession[] {
    return this.store.listSessions()
  }

  /** 校验会话后读取其完整消息历史。 */
  getMessages(sessionId: string): ChatMessage[] {
    this.requireSession(sessionId)
    return this.store.listMessages(sessionId)
  }

  /** 创建会话、保存首条用户消息并立即加入执行队列。 */
  createSession(prompt: string, title?: string): ChatSession {
    const normalizedPrompt = this.normalizePrompt(prompt)
    const now = Date.now()
    const config = this.store.getPublicConfig()
    const session: ChatSession = {
      id: randomUUID(),
      title: this.normalizeTitle(title || normalizedPrompt),
      status: 'idle',
      cwd: config.cwd,
      createdAt: now,
      updatedAt: now
    }

    this.store.saveSession(session)
    this.sendEvent({ type: 'session.created', payload: { session } })
    this.addUserMessage(session.id, normalizedPrompt)
    this.enqueue(session.id, normalizedPrompt)
    return session
  }

  /** 将用户消息追加到已有会话并排队执行。 */
  sendMessage(sessionId: string, prompt: string): void {
    this.requireSession(sessionId)
    const normalizedPrompt = this.normalizePrompt(prompt)
    this.addUserMessage(sessionId, normalizedPrompt)
    this.enqueue(sessionId, normalizedPrompt)
  }

  /** 同时清空排队任务、拒绝待决权限并中止当前执行。 */
  cancel(sessionId: string): void {
    const session = this.requireSession(sessionId)
    this.cancelledSessions.add(sessionId)
    this.queues.delete(sessionId)
    this.denyPendingPermissions(sessionId)
    this.runner.cancel(sessionId)
    this.updateSession({ ...session, status: 'idle', updatedAt: Date.now() })
  }

  /** 校验渲染进程提交的权限决策并结算对应请求。 */
  handlePermissionResponse(input: PermissionResponseInput): void {
    if (!input || typeof input.toolUseId !== 'string') throw new Error('权限响应无效')
    if (!['deny', 'allow-once', 'allow-always'].includes(input.decision)) {
      throw new Error('权限决策无效')
    }
    if (!this.resolvePermission(input.toolUseId, input.decision)) {
      throw new Error('权限请求已失效')
    }
  }

  /** 先终止会话相关异步状态，再删除持久化数据。 */
  deleteSession(sessionId: string): void {
    this.requireSession(sessionId)
    this.cancel(sessionId)
    this.store.deleteSession(sessionId)
    this.sendEvent({ type: 'session.deleted', payload: { sessionId } })
  }

  /** 保证同一会话串行执行，同时允许不同会话并行。 */
  private enqueue(sessionId: string, prompt: string): void {
    const queue = this.queues.get(sessionId) || []
    queue.push({ prompt })
    this.queues.set(sessionId, queue)

    if (!this.activeSessions.has(sessionId)) {
      void this.processQueue(sessionId)
    }
  }

  /** 持续消费单个会话队列，并在所有退出路径恢复一致状态。 */
  private async processQueue(sessionId: string): Promise<void> {
    if (this.activeSessions.has(sessionId)) return
    this.activeSessions.add(sessionId)
    this.cancelledSessions.delete(sessionId)

    try {
      while (!this.cancelledSessions.has(sessionId)) {
        const queue = this.queues.get(sessionId)
        const item = queue?.shift()
        if (!item) break

        const session = this.requireSession(sessionId)
        this.updateSession({ ...session, status: 'running', updatedAt: Date.now() })
        await this.processPrompt(session, item.prompt)
      }
    } finally {
      this.activeSessions.delete(sessionId)
      if (this.queues.get(sessionId)?.length === 0) this.queues.delete(sessionId)

      const session = this.store.getSession(sessionId)
      if (session && session.status === 'running') {
        this.updateSession({ ...session, status: 'idle', updatedAt: Date.now() })
      }
      this.cancelledSessions.delete(sessionId)
    }
  }

  /** 执行单条提示，将流事件、最终回复或错误写入会话。 */
  private async processPrompt(session: ChatSession, prompt: string): Promise<void> {
    try {
      const config = this.store.getRuntimeConfig()
      const result = await this.runner.run(session, prompt, config, {
        onDelta: (delta) => {
          this.sendEvent({ type: 'stream.delta', payload: { sessionId: session.id, delta } })
        },
        onActivity: (activity) => {
          this.sendEvent({ type: 'agent.activity', payload: { sessionId: session.id, activity } })
        },
        onPermission: (request, signal) => {
          return this.requestPermission(request, signal)
        }
      })

      // SDK 可能在取消后仍返回结果，迟到结果不能再写入历史记录。
      if (this.cancelledSessions.has(session.id)) return

      const current = this.requireSession(session.id)
      this.updateSession({
        ...current,
        runtimeSessionId: result.runtimeSessionId,
        status: 'idle',
        updatedAt: Date.now()
      })

      const assistantMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'assistant',
        content: result.content,
        createdAt: Date.now(),
        model: result.model,
        tokenUsage: result.tokenUsage
      }
      this.store.saveMessage(assistantMessage)
      this.sendEvent({ type: 'message.created', payload: { message: assistantMessage } })
    } catch (error) {
      if (this.cancelledSessions.has(session.id)) return

      const message = error instanceof Error ? error.message : String(error)
      const current = this.store.getSession(session.id)
      if (current) {
        this.updateSession({ ...current, status: 'error', updatedAt: Date.now() })
      }

      const errorMessage: ChatMessage = {
        id: randomUUID(),
        sessionId: session.id,
        role: 'assistant',
        content: `执行失败：${message}`,
        createdAt: Date.now(),
        isError: true
      }
      this.store.saveMessage(errorMessage)
      this.sendEvent({ type: 'message.created', payload: { message: errorMessage } })
      this.sendEvent({ type: 'run.error', payload: { sessionId: session.id, message } })
    }
  }

  /** 持久化用户消息并通知当前渲染进程。 */
  private addUserMessage(sessionId: string, prompt: string): void {
    const message: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: 'user',
      content: prompt,
      createdAt: Date.now()
    }
    this.store.saveMessage(message)
    this.sendEvent({ type: 'message.created', payload: { message } })
  }

  /** 统一持久化会话变更并广播权威状态。 */
  private updateSession(session: ChatSession): void {
    this.store.saveSession(session)
    this.sendEvent({ type: 'session.updated', payload: { session } })
  }

  /** 将 SDK 权限检查挂起为用户可响应、可中止且会超时的 Promise。 */
  private requestPermission(
    request: PermissionRequest,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    if (signal.aborted) return Promise.resolve('deny')

    return new Promise((resolve) => {
      const abortListener = (): void => {
        this.resolvePermission(request.toolUseId, 'deny')
      }
      // 无响应权限在 60 秒后默认拒绝，避免 Agent 永久占用会话队列。
      const timeout = setTimeout(() => {
        this.resolvePermission(request.toolUseId, 'deny')
      }, 60_000)

      this.pendingPermissions.set(request.toolUseId, {
        sessionId: request.sessionId,
        resolve,
        timeout,
        signal,
        abortListener
      })
      signal.addEventListener('abort', abortListener, { once: true })
      this.sendEvent({ type: 'permission.request', payload: { permission: request } })
    })
  }

  /** 作为用户响应、中止和超时路径共享的唯一权限清理入口。 */
  private resolvePermission(toolUseId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingPermissions.get(toolUseId)
    if (!pending) return false

    this.pendingPermissions.delete(toolUseId)
    clearTimeout(pending.timeout)
    pending.signal.removeEventListener('abort', pending.abortListener)
    this.sendEvent({ type: 'permission.dismiss', payload: { toolUseId } })
    pending.resolve(decision)
    return true
  }

  /** 批量拒绝属于指定会话的全部待决权限请求。 */
  private denyPendingPermissions(sessionId: string): void {
    for (const [toolUseId, pending] of this.pendingPermissions) {
      if (pending.sessionId === sessionId) this.resolvePermission(toolUseId, 'deny')
    }
  }

  /** 校验会话标识并返回持久化会话实体。 */
  private requireSession(sessionId: string): ChatSession {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('会话 ID 无效')
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    return session
  }

  /** 规范化用户提示并执行 IPC 边界长度限制。 */
  private normalizePrompt(prompt: string): string {
    if (typeof prompt !== 'string') throw new Error('消息格式无效')
    const normalized = prompt.trim()
    if (!normalized) throw new Error('消息不能为空')
    if (normalized.length > 100_000) throw new Error('消息内容过长')
    return normalized
  }

  /** 从首行生成适合侧边栏展示的短标题。 */
  private normalizeTitle(title: string): string {
    const firstLine = title.split(/\r?\n/, 1)[0].trim()
    return firstLine.slice(0, 32) || '新会话'
  }
}
