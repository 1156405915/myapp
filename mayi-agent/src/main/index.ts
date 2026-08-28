import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppConfigPatch, SendMessageInput, ServerEvent, StartSessionInput } from '../shared/protocol'
import { ClaudeAgentRunner } from './agent/claude-agent-runner'
import { SessionManager } from './session/session-manager'
import { AppStore } from './store/app-store'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f7f9f8',
    title: '蚂蚁',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  return window
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('拒绝来自未知窗口的 IPC 请求')
  }
}

function registerIpc(store: AppStore, sessions: SessionManager): void {
  ipcMain.handle('app:version', (event) => {
    assertTrustedSender(event)
    return app.getVersion()
  })
  ipcMain.handle('sessions:list', (event) => {
    assertTrustedSender(event)
    return sessions.listSessions()
  })
  ipcMain.handle('sessions:create', (event, input: StartSessionInput) => {
    assertTrustedSender(event)
    return sessions.createSession(input?.prompt, input?.title)
  })
  ipcMain.handle('sessions:messages', (event, sessionId: string) => {
    assertTrustedSender(event)
    return sessions.getMessages(sessionId)
  })
  ipcMain.handle('sessions:send', (event, input: SendMessageInput) => {
    assertTrustedSender(event)
    sessions.sendMessage(input?.sessionId, input?.prompt)
  })
  ipcMain.handle('sessions:cancel', (event, sessionId: string) => {
    assertTrustedSender(event)
    sessions.cancel(sessionId)
  })
  ipcMain.handle('sessions:delete', (event, sessionId: string) => {
    assertTrustedSender(event)
    sessions.deleteSession(sessionId)
  })
  ipcMain.handle('config:get', (event) => {
    assertTrustedSender(event)
    return store.getPublicConfig()
  })
  ipcMain.handle('config:save', (event, patch: AppConfigPatch) => {
    assertTrustedSender(event)
    if (!patch || typeof patch !== 'object') throw new Error('配置格式无效')
    return store.updateConfig(patch)
  })
  ipcMain.handle('config:select-directory', async (event) => {
    assertTrustedSender(event)
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Agent 工作目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    mainWindow = createWindow()
    const store = new AppStore()
    const runner = new ClaudeAgentRunner()
    const sessions = new SessionManager(store, runner, (event: ServerEvent) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:event', event)
    })
    registerIpc(store, sessions)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
