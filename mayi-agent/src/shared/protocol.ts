export type SessionStatus = 'idle' | 'running' | 'error'

export interface ChatSession {
  id: string
  title: string
  status: SessionStatus
  cwd: string
  runtimeSessionId?: string
  createdAt: number
  updatedAt: number
}

export interface TokenUsage {
  input: number
  output: number
  costUsd?: number
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  model?: string
  tokenUsage?: TokenUsage
  isError?: boolean
}

export interface PublicAppConfig {
  model: string
  cwd: string
  hasApiKey: boolean
}

export interface AppConfigPatch {
  apiKey?: string
  model?: string
  cwd?: string
}

export type AgentActivity =
  | { kind: 'thinking'; label: string }
  | { kind: 'tool'; label: string; toolName: string }

export type ServerEvent =
  | { type: 'session.created'; payload: { session: ChatSession } }
  | { type: 'session.updated'; payload: { session: ChatSession } }
  | { type: 'session.deleted'; payload: { sessionId: string } }
  | { type: 'message.created'; payload: { message: ChatMessage } }
  | { type: 'stream.delta'; payload: { sessionId: string; delta: string } }
  | { type: 'agent.activity'; payload: { sessionId: string; activity: AgentActivity } }
  | { type: 'run.error'; payload: { sessionId: string; message: string } }

export interface StartSessionInput {
  prompt: string
  title?: string
}

export interface SendMessageInput {
  sessionId: string
  prompt: string
}

export interface MayiApi {
  getVersion(): Promise<string>
  sessions: {
    list(): Promise<ChatSession[]>
    create(input: StartSessionInput): Promise<ChatSession>
    messages(sessionId: string): Promise<ChatMessage[]>
    send(input: SendMessageInput): Promise<void>
    cancel(sessionId: string): Promise<void>
    delete(sessionId: string): Promise<void>
  }
  config: {
    get(): Promise<PublicAppConfig>
    save(patch: AppConfigPatch): Promise<PublicAppConfig>
    selectDirectory(): Promise<string | null>
  }
  onEvent(callback: (event: ServerEvent) => void): () => void
}
