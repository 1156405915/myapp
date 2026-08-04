import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f7f9f8',
    title: '蚂蚁',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('app:version', () => app.getVersion())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
