import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version')
}

contextBridge.exposeInMainWorld('mayi', api)

export type MayiApi = typeof api
