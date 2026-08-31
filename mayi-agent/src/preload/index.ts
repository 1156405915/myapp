import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfigPatch,
  ChatMessage,
  ChatSession,
  MayiApi,
  PermissionResponseInput,
  PublicAppConfig,
  SendMessageInput,
  ServerEvent,
  StartSessionInput
} from '../shared/protocol'

// 这是渲染进程唯一可访问的主进程能力面，所有调用仍由主进程校验。
const api: MayiApi = {
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
