import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AgentActivity,
  AppConfigPatch,
  ChatMessage,
  ChatSession,
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
  const error = ref('')
  const initialized = ref(false)
  let unsubscribe: (() => void) | null = null
  let initializePromise: Promise<void> | null = null

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) || null
  )
  const isRunning = computed(() => activeSession.value?.status === 'running')

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

  async function send(prompt: string): Promise<void> {
    const text = prompt.trim()
    if (!text) return
    error.value = ''
    streamingContent.value = ''
    activity.value = { kind: 'thinking', label: '正在思考' }

    try {
      if (activeSessionId.value) {
        await window.mayi.sessions.send({ sessionId: activeSessionId.value, prompt: text })
      } else {
        const session = await window.mayi.sessions.create({ prompt: text })
        activeSessionId.value = session.id
      }
    } catch (reason) {
      setError(reason)
      activity.value = null
    }
  }

  async function cancel(): Promise<void> {
    if (!activeSessionId.value) return
    await window.mayi.sessions.cancel(activeSessionId.value)
    streamingContent.value = ''
    activity.value = null
  }

  async function createNewSession(): Promise<void> {
    activeSessionId.value = null
    messages.value = []
    streamingContent.value = ''
    activity.value = null
    error.value = ''
  }

  async function deleteSession(sessionId: string): Promise<void> {
    await window.mayi.sessions.delete(sessionId)
  }

  async function saveConfig(patch: AppConfigPatch): Promise<void> {
    config.value = await window.mayi.config.save(patch)
  }

  async function selectDirectory(): Promise<string | null> {
    return window.mayi.config.selectDirectory()
  }

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
      case 'run.error':
        if (event.payload.sessionId === activeSessionId.value) {
          error.value = event.payload.message
          activity.value = null
        }
        break
    }
  }

  function upsertSession(session: ChatSession): void {
    const index = sessions.value.findIndex((item) => item.id === session.id)
    if (index >= 0) sessions.value[index] = session
    else sessions.value.push(session)
    sessions.value.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  function setError(reason: unknown): void {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
    initializePromise = null
    initialized.value = false
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    messages,
    streamingContent,
    activity,
    config,
    error,
    initialized,
    isRunning,
    initialize,
    selectSession,
    send,
    cancel,
    createNewSession,
    deleteSession,
    saveConfig,
    selectDirectory,
    dispose
  }
})
