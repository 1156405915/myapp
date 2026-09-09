import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppConfigPatch,
  AttachmentBytesInput,
  ChatMessage,
  ChatSession,
  CreateProjectStandardSnapshotInput,
  CreateDraftSessionInput,
  InstallSkillDependenciesInput,
  MayiApi,
  ManualStandardImport,
  MessageAttachment,
  PermissionResponseInput,
  PublicAppConfig,
  ReviewStandardInput,
  RoleInfo,
  SendMessageInput,
  ServerEvent,
  SetSkillEnabledInput,
  SkillInfo,
  StandardQueryInput,
  StandardQueryResult,
  StandardVersion,
  ProjectStandardSnapshot,
  StartSessionInput
} from '../shared/protocol'

// 这是渲染进程唯一可访问的主进程能力面，所有调用仍由主进程校验。
const api: MayiApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (name) => ipcRenderer.invoke('projects:create', name),
    runs: (projectId) => ipcRenderer.invoke('projects:runs', projectId),
    artifacts: (projectId) => ipcRenderer.invoke('projects:artifacts', projectId),
    openArtifact: (projectId, artifactId) => ipcRenderer.invoke('projects:open-artifact', projectId, artifactId)
  },
  /** 获取当前应用版本。 */
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** 请求主进程在隔离窗口中打开外部地址。 */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  /** 请求主进程写入系统剪贴板。 */
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write-text', text),
  permissions: {
    /** 响应当前 Agent 工具权限请求。 */
    respond: (input: PermissionResponseInput): Promise<void> =>
      ipcRenderer.invoke('permissions:respond', input)
  },
  sessions: {
    /** 获取全部会话。 */
    list: (): Promise<ChatSession[]> => ipcRenderer.invoke('sessions:list'),
    /** 创建会话并提交首条消息。 */
    create: (input: StartSessionInput): Promise<ChatSession> =>
      ipcRenderer.invoke('sessions:create', input),
    /** 创建用于附件导入的空会话。 */
    createDraft: (input?: CreateDraftSessionInput): Promise<ChatSession> =>
      ipcRenderer.invoke('sessions:create-draft', input),
    /** 获取指定会话的消息。 */
    messages: (sessionId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('sessions:messages', sessionId),
    /** 向指定会话发送消息。 */
    send: (input: SendMessageInput): Promise<void> => ipcRenderer.invoke('sessions:send', input),
    /** 取消指定会话的执行。 */
    cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke('sessions:cancel', sessionId),
    /** 删除指定会话。 */
    delete: (sessionId: string): Promise<void> => ipcRenderer.invoke('sessions:delete', sessionId)
  },
  config: {
    /** 获取不含明文密钥的公开配置。 */
    get: (): Promise<PublicAppConfig> => ipcRenderer.invoke('config:get'),
    /** 保存允许渲染进程修改的配置字段。 */
    save: (patch: AppConfigPatch): Promise<PublicAppConfig> =>
      ipcRenderer.invoke('config:save', patch),
    /** 打开原生目录选择器。 */
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('config:select-directory')
  },
  skills: {
    /** 获取主进程发现的真实技能列表。 */
    list: (): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list'),
    /** 更新技能开关，结果以主进程返回列表为准。 */
    setEnabled: (input: SetSkillEnabledInput): Promise<SkillInfo[]> =>
      ipcRenderer.invoke('skills:set-enabled', input),
    installDependencies: (input: InstallSkillDependenciesInput): Promise<SkillInfo[]> =>
      ipcRenderer.invoke('skills:install-dependencies', input)
  },
  roles: {
    /** 获取主进程校验后的内置角色列表。 */
    list: (): Promise<RoleInfo[]> => ipcRenderer.invoke('roles:list')
  },
  knowledge: {
    importStandard: (input: ManualStandardImport): Promise<StandardVersion> =>
      ipcRenderer.invoke('knowledge:import-standard', input),
    reviewStandard: (input: ReviewStandardInput): Promise<StandardVersion> =>
      ipcRenderer.invoke('knowledge:review-standard', input),
    queryStandard: (input: StandardQueryInput): Promise<StandardQueryResult> =>
      ipcRenderer.invoke('knowledge:query-standard', input),
    createProjectSnapshot: (
      input: CreateProjectStandardSnapshotInput
    ): Promise<ProjectStandardSnapshot> =>
      ipcRenderer.invoke('knowledge:create-project-snapshot', input),
    latestProjectSnapshot: (sessionId: string): Promise<ProjectStandardSnapshot | undefined> =>
      ipcRenderer.invoke('knowledge:latest-project-snapshot', sessionId)
  },
  attachments: {
    /** 打开原生文件选择器并返回已安全复制的附件。 */
    select: (sessionId: string): Promise<MessageAttachment[]> =>
      ipcRenderer.invoke('attachments:select', sessionId),
    /** File 的真实路径仅在 preload 内解析，不直接暴露给渲染进程。 */
    importFiles: (sessionId: string, files: File[]): Promise<MessageAttachment[]> => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return ipcRenderer.invoke('attachments:import-paths', sessionId, paths)
    },
    /** 导入剪贴板中的内存图片。 */
    importBytes: (input: AttachmentBytesInput): Promise<MessageAttachment> =>
      ipcRenderer.invoke('attachments:import-bytes', input),
    /** 删除尚未发送的附件。 */
    discard: (attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:discard', attachmentId),
    /** 在系统资源管理器中定位附件。 */
    reveal: (attachmentId: string): Promise<void> =>
      ipcRenderer.invoke('attachments:reveal', attachmentId)
  },
  /** 订阅主进程事件，并返回必须在销毁时调用的退订函数。 */
  onEvent: (callback: (event: ServerEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ServerEvent): void =>
      callback(payload)
    ipcRenderer.on('server:event', listener)
    return () => ipcRenderer.removeListener('server:event', listener)
  }
}

contextBridge.exposeInMainWorld('mayi', api)

export type { MayiApi } from '../shared/protocol'
