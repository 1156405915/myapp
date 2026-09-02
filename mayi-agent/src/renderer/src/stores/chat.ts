import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AgentActivity,
  AppConfigPatch,
  ChatMessage,
  ChatSession,
  PermissionDecision,
  PermissionRequest,
  PublicAppConfig,
  ServerEvent
} from '../../../shared/protocol'

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const streamingContent = ref('')
  const activity = ref<AgentActivity | null>(null)
  const config = ref<PublicAppConfig | null>(null)
  const permissionQueue = ref<PermissionRequest[]>([])
  const error = ref('')
  const initialized = ref(false)
  let unsubscribe: (() => void) | null = null
  let initializePromise: Promise<void> | null = null

  /** 解析当前选中的会话实体。 */
  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) || null
  )
  /** 标识当前会话是否正在运行 Agent。 */
  const isRunning = computed(() => activeSession.value?.status === 'running')
  /** 只向权限弹窗暴露队列头部请求。 */
  const pendingPermission = computed(() => permissionQueue.value[0] || null)

  /** 合并并发初始化，并在读取初始数据前先订阅主进程事件。 */
  async function initialize(): Promise<void> {
    if (initialized.value) return
    if (initializePromise) return initializePromise
    initializePromise = (async () => {
      unsubscribe = window.mayi.onEvent(handleEvent)
      try {
        const [storedSessions, storedConfig] = await Promise.all([
          window.mayi.sessions.list(),
          window.mayi.config.get()
        ])
        sessions.value = storedSessions
        config.value = storedConfig
        if (storedSessions[0]) await selectSession(storedSessions[0].id)
        initialized.value = true
      } catch (reason) {
        setError(reason)
      } finally {
        initializePromise = null
      }
    })()
    return initializePromise
  }

  /** 切换活动会话并加载其持久化消息。 */
  async function selectSession(sessionId: string): Promise<void> {
    activeSessionId.value = sessionId
    streamingContent.value = ''
    activity.value = null
    error.value = ''
    try {
      messages.value = await window.mayi.sessions.messages(sessionId)
    } catch (reason) {
      setError(reason)
    }
  }

  /** 根据是否已有活动会话选择创建或追加消息流程。 */
  async function send(prompt: string, attachmentIds: string[] = []): Promise<boolean> {
    const text = prompt.trim()
    if (!text && attachmentIds.length === 0) return false
    error.value = ''
    streamingContent.value = ''
    activity.value = { kind: 'thinking', label: '正在思考' }

    try {
      if (activeSessionId.value) {
        await window.mayi.sessions.send({
          sessionId: activeSessionId.value,
          prompt: text,
          attachmentIds
        })
      } else {
        if (attachmentIds.length > 0) throw new Error('附件发送前必须先创建会话')
        const session = await window.mayi.sessions.create({ prompt: text })
        activeSessionId.value = session.id
      }
      return true
    } catch (reason) {
      setError(reason)
      activity.value = null
      return false
    }
  }

  /** 确保附件导入前存在固定工作区的草稿会话。 */
  async function ensureDraftSession(): Promise<string> {
    if (activeSessionId.value) return activeSessionId.value
    const session = await window.mayi.sessions.createDraft()
    activeSessionId.value = session.id
    return session.id
  }

  /** 取消当前会话并清理本地流式展示状态。 */
  async function cancel(): Promise<void> {
    if (!activeSessionId.value) return
    await window.mayi.sessions.cancel(activeSessionId.value)
    streamingContent.value = ''
    activity.value = null
  }

  /** 将界面重置为尚未持久化的新会话状态。 */
  async function createNewSession(): Promise<void> {
    activeSessionId.value = null
    messages.value = []
    streamingContent.value = ''
    activity.value = null
    error.value = ''
  }

  /** 请求主进程删除指定会话。 */
  async function deleteSession(sessionId: string): Promise<void> {
    await window.mayi.sessions.delete(sessionId)
  }

  /** 保存配置并用主进程返回的公开配置刷新本地状态。 */
  async function saveConfig(patch: AppConfigPatch): Promise<void> {
    config.value = await window.mayi.config.save(patch)
  }

  /** 打开原生目录选择器并返回选择结果。 */
  async function selectDirectory(): Promise<string | null> {
    return window.mayi.config.selectDirectory()
  }

  /** 响应权限队列头部请求，等待主进程事件负责出队。 */
  async function respondToPermission(decision: PermissionDecision): Promise<void> {
    const permission = pendingPermission.value
    if (!permission) return
    await window.mayi.permissions.respond({ toolUseId: permission.toolUseId, decision })
  }

  /** 将主进程事件作为会话、消息流和权限状态的权威来源。 */
  function handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'session.created':
        upsertSession(event.payload.session)
        activeSessionId.value = event.payload.session.id
        messages.value = []
        break
      case 'session.updated':
        upsertSession(event.payload.session)
        if (event.payload.session.id === activeSessionId.value && event.payload.session.status !== 'running') {
          activity.value = null
        }
        break
      case 'session.deleted':
        sessions.value = sessions.value.filter((session) => session.id !== event.payload.sessionId)
        if (activeSessionId.value === event.payload.sessionId) void createNewSession()
        break
      case 'message.created':
        if (event.payload.message.sessionId === activeSessionId.value) {
          messages.value.push(event.payload.message)
          if (event.payload.message.role === 'assistant') {
            // 最终持久化消息取代临时流文本，避免同一回复重复显示。
            streamingContent.value = ''
            activity.value = null
          }
        }
        break
      case 'stream.delta':
        if (event.payload.sessionId === activeSessionId.value) {
          streamingContent.value += event.payload.delta
        }
        break
      case 'agent.activity':
        if (event.payload.sessionId === activeSessionId.value) activity.value = event.payload.activity
        break
      case 'permission.request':
        if (!permissionQueue.value.some((item) => item.toolUseId === event.payload.permission.toolUseId)) {
          permissionQueue.value.push(event.payload.permission)
        }
        break
      case 'permission.dismiss':
        permissionQueue.value = permissionQueue.value.filter(
          (item) => item.toolUseId !== event.payload.toolUseId
        )
        break
      case 'run.error':
        if (event.payload.sessionId === activeSessionId.value) {
          error.value = event.payload.message
          activity.value = null
        }
        break
    }
  }

  /** 插入或更新会话，并维持最近更新优先的顺序。 */
  function upsertSession(session: ChatSession): void {
    const index = sessions.value.findIndex((item) => item.id === session.id)
    if (index >= 0) sessions.value[index] = session
    else sessions.value.push(session)
    sessions.value.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** 将未知异常归一化为可直接展示的错误文本。 */
  function setError(reason: unknown): void {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }

  /** 撤销 IPC 订阅并恢复可重新初始化的干净状态。 */
  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    initializePromise = null
    initialized.value = false
    permissionQueue.value = []
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    messages,
    streamingContent,
    activity,
    config,
    pendingPermission,
    error,
    initialized,
    isRunning,
    initialize,
    selectSession,
    send,
    ensureDraftSession,
    cancel,
    createNewSession,
    deleteSession,
    saveConfig,
    selectDirectory,
    respondToPermission,
    dispose
  }
})
