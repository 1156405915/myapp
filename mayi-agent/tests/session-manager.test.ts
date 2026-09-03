import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunResult } from '../src/main/agent/claude-agent-runner'
import type {
  ChatMessage,
  ChatSession,
  MessageAttachment,
  PermissionDecision,
  ServerEvent
} from '../src/shared/protocol'
import { SessionManager } from '../src/main/session/session-manager'
import type { AppStore } from '../src/main/store/app-store'
import type { ClaudeAgentRunner } from '../src/main/agent/claude-agent-runner'
import type { SkillsManager } from '../src/main/skills/skills-manager'
import type { RolesManager } from '../src/main/roles/roles-manager'
import type { AttachmentManager } from '../src/main/attachments/attachment-manager'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

/** 创建可由测试精确控制完成时机的 Promise。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

/** 等待当前异步队列中的会话状态更新完成。 */
async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 构造只覆盖 SessionManager 所需接口的内存存储。 */
function createStore(): AppStore & {
  sessions: ChatSession[]
  messages: ChatMessage[]
  attachments: MessageAttachment[]
} {
  const sessions: ChatSession[] = []
  const messages: ChatMessage[] = []
  const attachments: MessageAttachment[] = []
  return {
    sessions,
    messages,
    attachments,
    getPublicConfig: () => ({
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      cwd: process.cwd(),
      hasApiKey: true
    }),
    getRuntimeConfig: () => ({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      cwd: process.cwd(),
      hasApiKey: true
    }),
    listSessions: () => [...sessions],
    getSession: (sessionId: string) => sessions.find((session) => session.id === sessionId),
    saveSession: (session: ChatSession) => {
      const index = sessions.findIndex((item) => item.id === session.id)
      if (index >= 0) sessions[index] = session
      else sessions.push(session)
    },
    deleteSession: (sessionId: string) => {
      const index = sessions.findIndex((session) => session.id === sessionId)
      if (index >= 0) sessions.splice(index, 1)
      for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        if (messages[messageIndex].sessionId === sessionId) messages.splice(messageIndex, 1)
      }
    },
    listMessages: (sessionId: string) => messages.filter((message) => message.sessionId === sessionId),
    getAttachments: (_sessionId: string, ids: string[]) =>
      ids.map((id) => attachments.find((attachment) => attachment.id === id)).filter(Boolean),
    saveMessage: (message: ChatMessage) => messages.push(message)
  } as unknown as AppStore & {
    sessions: ChatSession[]
    messages: ChatMessage[]
    attachments: MessageAttachment[]
  }
}

/** 构造可注入执行行为的 Agent Runner。 */
function createRunner(
  implementation: (
    session: ChatSession,
    prompt: string,
    callbacks: {
      onPermission(
        request: {
          sessionId: string
          toolUseId: string
          toolName: string
          input: Record<string, unknown>
          canAlwaysAllow: boolean
        },
        signal: AbortSignal
      ): Promise<PermissionDecision>
    },
    config: { enabledSkillIds: string[]; skillsPluginPath: string; rolePrompt?: string }
  ) => Promise<AgentRunResult>
): ClaudeAgentRunner & { cancel: ReturnType<typeof vi.fn>; forgetSession: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn()
  const forgetSession = vi.fn()
  return {
    run: vi.fn((session, prompt, config, callbacks) => implementation(session, prompt, callbacks, config)),
    cancel,
    forgetSession
  } as unknown as ClaudeAgentRunner & {
    cancel: ReturnType<typeof vi.fn>
    forgetSession: ReturnType<typeof vi.fn>
  }
}

/** 创建测试对象并收集所有主进程事件。 */
function createManager(store: AppStore, runner: ClaudeAgentRunner): {
  manager: SessionManager
  events: ServerEvent[]
} {
  const events: ServerEvent[] = []
  const skills = {
    getEnabledSkillIds: vi.fn(() => ['pdf', 'document-summary']),
    getPluginPath: vi.fn(() => 'test-skills-plugin')
  } as unknown as SkillsManager
  const attachments = {
    deleteSessionFiles: vi.fn()
  } as unknown as AttachmentManager
  const roles = {
    getRole: vi.fn(() => undefined)
  } as unknown as RolesManager
  return {
    manager: new SessionManager(store, runner, (event) => events.push(event), skills, roles, attachments),
    events
  }
}

/** 创建标准成功结果，避免测试依赖真实模型。 */
function successfulResult(content: string): AgentRunResult {
  return {
    blocks: [{ type: 'text', text: content }],
    runtimeSessionId: `runtime-${content}`,
    model: 'test-model'
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SessionManager 会话队列', () => {
  it('每条消息开始时使用最新技能快照', async () => {
    const store = createStore()
    const snapshots: string[][] = []
    const skills = {
      getEnabledSkillIds: vi
        .fn()
        .mockReturnValueOnce(['pdf'])
        .mockReturnValueOnce(['pdf', 'document-summary']),
      getPluginPath: vi.fn(() => 'test-skills-plugin')
    } as unknown as SkillsManager
    const runner = createRunner(async (_session, prompt, _callbacks, config) => {
      snapshots.push([...config.enabledSkillIds])
      return successfulResult(prompt)
    })
    const manager = new SessionManager(
      store,
      runner,
      () => undefined,
      skills,
      { getRole: vi.fn(() => undefined) } as unknown as RolesManager,
      { deleteSessionFiles: vi.fn() } as unknown as AttachmentManager
    )

    const session = manager.createSession('第一条')
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    manager.sendMessage(session.id, '第二条')
    await vi.waitFor(() => expect(snapshots).toHaveLength(2))

    expect(snapshots).toEqual([['pdf'], ['pdf', 'document-summary']])
  })

  it('会话角色决定独立技能快照和工作流提示', async () => {
    const store = createStore()
    const captured: Array<{ skillIds: string[]; rolePrompt?: string }> = []
    const skills = {
      getRequiredSkillIds: vi.fn(() => ['construction-organization-design', 'image-analysis']),
      getEnabledSkillIds: vi.fn(() => ['document-summary']),
      getPluginPath: vi.fn(() => 'test-skills-plugin')
    } as unknown as SkillsManager
    const roles = {
      getRole: vi.fn((roleId?: string) =>
        roleId
          ? {
              id: roleId,
              displayName: '施组编制专家',
              description: '编制施工组织设计。',
              icon: 'task',
              requiredSkillIds: [
                'construction-organization-design',
                'hefei-qingtian-precheck',
                'image-analysis'
              ],
              prompt: '执行施组编制工作流。',
              schemaVersion: 1
            }
          : undefined
      )
    } as unknown as RolesManager
    const runner = createRunner(async (_session, prompt, _callbacks, config) => {
      captured.push({ skillIds: [...config.enabledSkillIds], rolePrompt: config.rolePrompt })
      return successfulResult(prompt)
    })
    const manager = new SessionManager(
      store,
      runner,
      () => undefined,
      skills,
      roles,
      { deleteSessionFiles: vi.fn() } as unknown as AttachmentManager
    )

    const session = manager.createSession('编制施组', undefined, 'construction-organization-expert')
    await vi.waitFor(() => expect(captured).toHaveLength(1))

    expect(session.roleId).toBe('construction-organization-expert')
    expect(skills.getRequiredSkillIds).toHaveBeenCalledWith([
      'construction-organization-design',
      'hefei-qingtian-precheck',
      'image-analysis'
    ])
    expect(captured[0]).toEqual({
      skillIds: ['construction-organization-design', 'image-analysis'],
      rolePrompt: '执行施组编制工作流。'
    })
  })

  it('同一会话严格串行执行提示', async () => {
    const store = createStore()
    const executions: Array<{ prompt: string; result: Deferred<AgentRunResult> }> = []
    const runner = createRunner(async (_session, prompt) => {
      const result = deferred<AgentRunResult>()
      executions.push({ prompt, result })
      return result.promise
    })
    const { manager } = createManager(store, runner)

    const session = manager.createSession('第一条')
    manager.sendMessage(session.id, '第二条')
    expect(executions.map((item) => item.prompt)).toEqual(['第一条'])

    executions[0].result.resolve(successfulResult('first'))
    await vi.waitFor(() => {
      expect(executions.map((item) => item.prompt)).toEqual(['第一条', '第二条'])
    })

    executions[1].result.resolve(successfulResult('second'))
    await vi.waitFor(() => {
      expect(store.listMessages(session.id).filter((message) => message.role === 'assistant')).toHaveLength(2)
    })
  })

  it('不同会话可以并行执行', () => {
    const store = createStore()
    const pending: Deferred<AgentRunResult>[] = []
    const runner = createRunner(async () => {
      const result = deferred<AgentRunResult>()
      pending.push(result)
      return result.promise
    })
    const { manager } = createManager(store, runner)

    manager.createSession('会话一')
    manager.createSession('会话二')
    expect(pending).toHaveLength(2)
  })

  it('取消会话会清空尚未执行的提示并忽略迟到结果', async () => {
    const store = createStore()
    const firstRun = deferred<AgentRunResult>()
    const runner = createRunner(async () => firstRun.promise)
    const { manager } = createManager(store, runner)

    const session = manager.createSession('第一条')
    manager.sendMessage(session.id, '不会执行')
    manager.cancel(session.id)
    firstRun.resolve(successfulResult('late-result'))
    await flushAsyncWork()

    expect(runner.cancel).toHaveBeenCalledWith(session.id)
    expect(runner.run).toHaveBeenCalledTimes(1)
    expect(store.listMessages(session.id).filter((message) => message.role === 'assistant')).toHaveLength(0)
    expect(store.getSession(session.id)?.status).toBe('idle')
  })

  it('按消息保存并传递不可变的附件快照', async () => {
    const store = createStore()
    const captured: MessageAttachment[][] = []
    const attachment: MessageAttachment = {
      id: 'attachment-1',
      name: '合同.pdf',
      kind: 'document',
      mimeType: 'application/pdf',
      size: 123,
      relativePath: '.mayi/attachments/session/file.pdf'
    }
    store.attachments.push(attachment)
    const runner = {
      run: vi.fn(async (_session, _prompt, _config, _callbacks, attachments) => {
        captured.push(attachments.map((item: MessageAttachment) => ({ ...item })))
        return successfulResult('done')
      }),
      cancel: vi.fn(),
      forgetSession: vi.fn()
    } as unknown as ClaudeAgentRunner
    const { manager } = createManager(store, runner)
    const session = manager.createDraftSession()
    attachment.relativePath = `.mayi/attachments/${session.id}/file.pdf`

    manager.sendMessage(session.id, '', [attachment.id])
    attachment.name = '被修改的名称.pdf'
    await vi.waitFor(() => expect(captured).toHaveLength(1))

    expect(captured[0][0].name).toBe('合同.pdf')
    expect(store.listMessages(session.id)[0].blocks).toEqual([
      { type: 'attachment', attachment: expect.objectContaining({ id: attachment.id, name: '合同.pdf' }) }
    ])
  })
})

describe('SessionManager 权限生命周期', () => {
  it('取消会话会拒绝待决权限', async () => {
    const store = createStore()
    const decisions: PermissionDecision[] = []
    const runner = createRunner(async (session, _prompt, callbacks) => {
      const controller = new AbortController()
      const decision = await callbacks.onPermission(
        {
          sessionId: session.id,
          toolUseId: 'tool-cancel',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
          canAlwaysAllow: false
        },
        controller.signal
      )
      decisions.push(decision)
      return successfulResult('cancelled')
    })
    const { manager, events } = createManager(store, runner)

    const session = manager.createSession('需要权限')
    await flushAsyncWork()
    expect(events.some((event) => event.type === 'permission.request')).toBe(true)

    manager.cancel(session.id)
    await flushAsyncWork()
    expect(decisions).toEqual(['deny'])
  })

  it('权限请求超过六十秒后默认拒绝', async () => {
    vi.useFakeTimers()
    const store = createStore()
    const decisions: PermissionDecision[] = []
    const runner = createRunner(async (session, _prompt, callbacks) => {
      const decision = await callbacks.onPermission(
        {
          sessionId: session.id,
          toolUseId: 'tool-timeout',
          toolName: 'Write',
          input: { file_path: 'output.txt' },
          canAlwaysAllow: true
        },
        new AbortController().signal
      )
      decisions.push(decision)
      return successfulResult('timeout')
    })
    const { manager } = createManager(store, runner)

    manager.createSession('等待超时')
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncWork()
    expect(decisions).toEqual(['deny'])
  })

  it('已经结算的权限响应不能重复使用', async () => {
    vi.useFakeTimers()
    const store = createStore()
    const runner = createRunner(async (session, _prompt, callbacks) => {
      await callbacks.onPermission(
        {
          sessionId: session.id,
          toolUseId: 'tool-expired',
          toolName: 'Edit',
          input: { file_path: 'file.txt' },
          canAlwaysAllow: true
        },
        new AbortController().signal
      )
      return successfulResult('expired')
    })
    const { manager } = createManager(store, runner)

    manager.createSession('过期权限')
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncWork()

    expect(() =>
      manager.handlePermissionResponse({ toolUseId: 'tool-expired', decision: 'allow-once' })
    ).toThrow('权限请求已失效')
  })
})

