import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatSession, ServerEvent } from '../../shared/protocol'
import { ClaudeAgentRunner } from '../agent/claude-agent-runner'
import { AppStore } from '../store/app-store'

interface QueuedPrompt {
  prompt: string
}

export class SessionManager {
  private readonly queues = new Map<string, QueuedPrompt[]>()
  private readonly activeSessions = new Set<string>()
  private readonly cancelledSessions = new Set<string>()

  constructor(
    private readonly store: AppStore,
    private readonly runner: ClaudeAgentRunner,
    private readonly sendEvent: (event: ServerEvent) => void
  ) {}

  listSessions(): ChatSession[] {
    return this.store.listSessions()
  }

  getMessages(sessionId: string): ChatMessage[] {
    this.requireSession(sessionId)
    return this.store.listMessages(sessionId)
  }

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

  sendMessage(sessionId: string, prompt: string): void {
    this.requireSession(sessionId)
    const normalizedPrompt = this.normalizePrompt(prompt)
    this.addUserMessage(sessionId, normalizedPrompt)
    this.enqueue(sessionId, normalizedPrompt)
  }

  cancel(sessionId: string): void {
    const session = this.requireSession(sessionId)
    this.cancelledSessions.add(sessionId)
    this.queues.delete(sessionId)
    this.runner.cancel(sessionId)
    this.updateSession({ ...session, status: 'idle', updatedAt: Date.now() })
  }

  deleteSession(sessionId: string): void {
    this.requireSession(sessionId)
    this.cancel(sessionId)
    this.store.deleteSession(sessionId)
    this.sendEvent({ type: 'session.deleted', payload: { sessionId } })
  }

  private enqueue(sessionId: string, prompt: string): void {
    const queue = this.queues.get(sessionId) || []
    queue.push({ prompt })
    this.queues.set(sessionId, queue)

    if (!this.activeSessions.has(sessionId)) {
      void this.processQueue(sessionId)
    }
  }

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

  private async processPrompt(session: ChatSession, prompt: string): Promise<void> {
    try {
      const config = this.store.getRuntimeConfig()
      const result = await this.runner.run(session, prompt, config, {
        onDelta: (delta) => {
          this.sendEvent({ type: 'stream.delta', payload: { sessionId: session.id, delta } })
        },
        onActivity: (activity) => {
          this.sendEvent({ type: 'agent.activity', payload: { sessionId: session.id, activity } })
        }
      })

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

  private updateSession(session: ChatSession): void {
    this.store.saveSession(session)
    this.sendEvent({ type: 'session.updated', payload: { session } })
  }

  private requireSession(sessionId: string): ChatSession {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('会话 ID 无效')
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    return session
  }

  private normalizePrompt(prompt: string): string {
    if (typeof prompt !== 'string') throw new Error('消息格式无效')
    const normalized = prompt.trim()
    if (!normalized) throw new Error('消息不能为空')
    if (normalized.length > 100_000) throw new Error('消息内容过长')
    return normalized
  }

  private normalizeTitle(title: string): string {
    const firstLine = title.split(/\r?\n/, 1)[0].trim()
    return firstLine.slice(0, 32) || '新会话'
  }
}
