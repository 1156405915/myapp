import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfigPatch,
  ChatMessage,
  ChatSession,
  MayiApi,
  PublicAppConfig,
  SendMessageInput,
  ServerEvent,
  StartSessionInput
} from '../shared/protocol'

const api: MayiApi = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  sessions: {
    list: (): Promise<ChatSession[]> => ipcRenderer.invoke('sessions:list'),
    create: (input: StartSessionInput): Promise<ChatSession> =>
      ipcRenderer.invoke('sessions:create', input),
    messages: (sessionId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('sessions:messages', sessionId),
    send: (input: SendMessageInput): Promise<void> => ipcRenderer.invoke('sessions:send', input),
    cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke('sessions:cancel', sessionId),
    delete: (sessionId: string): Promise<void> => ipcRenderer.invoke('sessions:delete', sessionId)
  },
  config: {
    get: (): Promise<PublicAppConfig> => ipcRenderer.invoke('config:get'),
    save: (patch: AppConfigPatch): Promise<PublicAppConfig> =>
      ipcRenderer.invoke('config:save', patch),
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('config:select-directory')
  },
  onEvent: (callback: (event: ServerEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ServerEvent): void =>
      callback(payload)
    ipcRenderer.on('server:event', listener)
    return () => ipcRenderer.removeListener('server:event', listener)
  }
}

contextBridge.exposeInMainWorld('mayi', api)

export type { MayiApi } from '../shared/protocol'
