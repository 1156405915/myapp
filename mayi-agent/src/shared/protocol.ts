import type { ProjectSummary, WorkflowSummary, ArtifactSummary } from './workflow'
import type {
  CreateProjectStandardSnapshotInput,
  ManualStandardImport,
  ProjectStandardSnapshot,
  StandardQueryInput,
  StandardQueryResult,
  StandardVerificationStatus,
  StandardVersion
} from './knowledge-types'

export type * from './knowledge-types'

export type SessionStatus = 'idle' | 'running' | 'error'

export interface ChatSession {
  id: string
  title: string
  status: SessionStatus
  cwd: string
  roleId?: string
  runtimeSessionId?: string
  createdAt: number
  updatedAt: number
}

export interface TokenUsage {
  input: number
  output: number
  costUsd?: number
}

export interface ContextUsage {
  usedTokens: number
  maxTokens: number
}

export type AttachmentKind = 'image' | 'document' | 'text'

export interface MessageAttachment {
  id: string
  name: string
  kind: AttachmentKind
  mimeType: string
  size: number
  relativePath: string
  width?: number
  height?: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: MessageAttachment }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'error'; message: string }

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  blocks: ContentBlock[]
  createdAt: number
  model?: string
  tokenUsage?: TokenUsage
  contextUsage?: ContextUsage
  durationMs?: number
  isError?: boolean
}

export interface PublicAppConfig {
  baseUrl: string
  model: string
  cwd: string
  hasApiKey: boolean
}

export interface AppConfigPatch {
  /** 省略或传入空字符串表示保留已经存储的密钥。 */
  apiKey?: string
  /** 传入空字符串时恢复 DeepSeek 默认地址。 */
  baseUrl?: string
  model?: string
  cwd?: string
}

export type AgentActivity =
  { kind: 'thinking'; label: string } | { kind: 'tool'; label: string; toolName: string }

export type PermissionDecision = 'deny' | 'allow-once' | 'allow-always'

export interface PermissionRequest {
  sessionId: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  canAlwaysAllow: boolean
}

export interface PermissionResponseInput {
  toolUseId: string
  decision: PermissionDecision
}

export type SkillSource = 'builtin'
export type SkillDependencyStatus = 'available' | 'missing' | 'unknown'

export interface SkillDependency {
  id: string
  label: string
  type: 'skill' | 'command'
  status: SkillDependencyStatus
  required: boolean
  installable?: boolean
}

export interface SkillInfo {
  id: string
  displayName: string
  description: string
  category: string
  icon: string
  version: string
  source: SkillSource
  sourceLabel: string
  license: string
  recommended: boolean
  enabled: boolean
  /** 当前技能因哪些已启用的工作流被传递启用。 */
  enabledBy: string[]
  available: boolean
  dependencies: SkillDependency[]
}

export interface RoleInfo {
  id: string
  displayName: string
  description: string
  icon: string
  requiredSkillIds: string[]
}

export interface SetSkillEnabledInput {
  id: string
  enabled: boolean
}

export interface InstallSkillDependenciesInput {
  id: string
}

export type ServerEvent =
  | { type: 'session.created'; payload: { session: ChatSession } }
  | { type: 'session.updated'; payload: { session: ChatSession } }
  | { type: 'session.deleted'; payload: { sessionId: string } }
  | { type: 'message.created'; payload: { message: ChatMessage } }
  | { type: 'stream.delta'; payload: { sessionId: string; delta: string } }
  | { type: 'agent.activity'; payload: { sessionId: string; activity: AgentActivity } }
  | { type: 'permission.request'; payload: { permission: PermissionRequest } }
  | { type: 'permission.dismiss'; payload: { toolUseId: string } }
  | { type: 'run.error'; payload: { sessionId: string; message: string } }

export interface StartSessionInput {
  prompt: string
  title?: string
  roleId?: string
}

export interface CreateDraftSessionInput {
  roleId?: string
}

export interface SendMessageInput {
  sessionId: string
  prompt: string
  attachmentIds?: string[]
}

export interface AttachmentBytesInput {
  sessionId: string
  name: string
  mimeType: string
  bytes: Uint8Array
}

export interface ReviewStandardInput {
  versionId: string
  status: StandardVerificationStatus
}

export interface MayiApi {
  projects: {
    list(): Promise<ProjectSummary[]>
    create(name: string): Promise<ProjectSummary>
    runs(projectId: string): Promise<WorkflowSummary[]>
    artifacts(projectId: string): Promise<ArtifactSummary[]>
    openArtifact(projectId: string, artifactId: string): Promise<void>
  }
  /** 获取应用版本。 */
  getVersion(): Promise<string>
  /** 在隔离窗口中打开外部地址。 */
  openExternal(url: string): Promise<void>
  /** 写入系统剪贴板。 */
  copyText(text: string): Promise<void>
  permissions: {
    /** 响应 Agent 工具权限请求。 */
    respond(input: PermissionResponseInput): Promise<void>
  }
  sessions: {
    /** 获取全部会话。 */
    list(): Promise<ChatSession[]>
    /** 创建会话并提交首条消息。 */
    create(input: StartSessionInput): Promise<ChatSession>
    /** 创建尚未发送消息的会话，用于先导入附件。 */
    createDraft(input?: CreateDraftSessionInput): Promise<ChatSession>
    /** 获取会话消息历史。 */
    messages(sessionId: string): Promise<ChatMessage[]>
    /** 向已有会话发送消息。 */
    send(input: SendMessageInput): Promise<void>
    /** 取消会话执行。 */
    cancel(sessionId: string): Promise<void>
    /** 删除会话及其消息。 */
    delete(sessionId: string): Promise<void>
  }
  config: {
    /** 获取公开应用配置。 */
    get(): Promise<PublicAppConfig>
    /** 保存应用配置补丁。 */
    save(patch: AppConfigPatch): Promise<PublicAppConfig>
    /** 选择 Agent 工作目录。 */
    selectDirectory(): Promise<string | null>
  }
  skills: {
    /** 获取 Agent 实际可发现的内置技能。 */
    list(): Promise<SkillInfo[]>
    /** 更新技能状态并返回最新权威列表。 */
    setEnabled(input: SetSkillEnabledInput): Promise<SkillInfo[]>
    /** 安装指定技能缺失的受支持系统依赖。 */
    installDependencies(input: InstallSkillDependenciesInput): Promise<SkillInfo[]>
  }
  roles: {
    /** 获取应用内置角色。 */
    list(): Promise<RoleInfo[]>
  }
  knowledge: {
    /** 导入结构化官方标准元数据，默认进入待审核状态。 */
    importStandard(input: ManualStandardImport): Promise<StandardVersion>
    /** 由可信界面更新标准核验状态。 */
    reviewStandard(input: ReviewStandardInput): Promise<StandardVersion>
    /** 按项目适用日期查询本地缓存并按策略尝试官方来源。 */
    queryStandard(input: StandardQueryInput): Promise<StandardQueryResult>
    /** 创建当前会话绑定的不可变项目标准快照。 */
    createProjectSnapshot(input: CreateProjectStandardSnapshotInput): Promise<ProjectStandardSnapshot>
    /** 读取当前会话最近一次标准快照。 */
    latestProjectSnapshot(sessionId: string): Promise<ProjectStandardSnapshot | undefined>
  }
  attachments: {
    /** 使用原生选择器导入文件。 */
    select(sessionId: string): Promise<MessageAttachment[]>
    /** 导入拖拽文件；路径只在 preload 内解析。 */
    importFiles(sessionId: string, files: File[]): Promise<MessageAttachment[]>
    /** 导入剪贴板中没有本地路径的图片。 */
    importBytes(input: AttachmentBytesInput): Promise<MessageAttachment>
    /** 删除尚未发送的附件。 */
    discard(attachmentId: string): Promise<void>
    /** 在资源管理器中定位附件。 */
    reveal(attachmentId: string): Promise<void>
  }
  /** 订阅主进程事件并返回退订函数。 */
  onEvent(callback: (event: ServerEvent) => void): () => void
}
