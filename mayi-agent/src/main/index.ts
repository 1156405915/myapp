import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AppConfigPatch,
  AttachmentBytesInput,
  CreateDraftSessionInput,
  CreateProjectStandardSnapshotInput,
  InstallSkillDependenciesInput,
  ManualStandardImport,
  PermissionResponseInput,
  ReviewStandardInput,
  SendMessageInput,
  ServerEvent,
  SetSkillEnabledInput,
  StandardQueryInput,
  StartSessionInput
} from '../shared/protocol'
import { ClaudeAgentRunner } from './agent/claude-agent-runner'
import { AttachmentManager } from './attachments/attachment-manager'
import { SessionManager } from './session/session-manager'
import { SkillsManager } from './skills/skills-manager'
import { commandLabel } from './skills/command-dependencies'
import { ConstructionKnowledgeService } from './knowledge/construction-knowledge-service'
import { RolesManager } from './roles/roles-manager'
import { AppStore } from './store/app-store'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let appStore: AppStore | null = null
const browserWindows = new Set<BrowserWindow>()
const hasSingleInstanceLock = app.requestSingleInstanceLock()

/** 仅接受 HTTP(S) 地址，阻止外部链接触发本地协议或脚本协议。 */
function getExternalUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** 在隔离的应用内浏览器窗口中打开已验证的外部网页。 */
function createBrowserWindow(value: string, parent: BrowserWindow | null = mainWindow): void {
  const externalUrl = getExternalUrl(value)
  if (!externalUrl) return

  const browserWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    show: false,
    autoHideMenuBar: true,
    title: '蚂蚁浏览器',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  browserWindows.add(browserWindow)
  browserWindow.once('ready-to-show', () => browserWindow.show())
  // 子页面的新窗口请求继续进入隔离浏览器，原始导航始终被拒绝。
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    createBrowserWindow(url, browserWindow)
    return { action: 'deny' }
  })
  browserWindow.on('closed', () => browserWindows.delete(browserWindow))
  void browserWindow.loadURL(externalUrl)
}

/** 创建承载可信渲染页面的主窗口。 */
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
  // 主页面不得直接承载外部网页，新窗口请求统一转交沙箱浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    createBrowserWindow(url, window)
    return { action: 'deny' }
  })
  // 阻止主渲染器离开应用入口，避免外部页面获得预加载桥接能力。
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    createBrowserWindow(url, window)
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

/** 确保特权 IPC 只能由唯一的可信主窗口调用。 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('拒绝来自未知窗口的 IPC 请求')
  }
}

/** 注册经过发送方校验和输入校验的主进程 IPC 能力。 */
function registerIpc(
  store: AppStore,
  sessions: SessionManager,
  skills: SkillsManager,
  roles: RolesManager,
  attachments: AttachmentManager,
  knowledge: ConstructionKnowledgeService
): void {
  /** 返回应用版本，不向渲染进程暴露 Electron 对象。 */
  ipcMain.handle('app:version', (event) => {
    assertTrustedSender(event)
    return app.getVersion()
  })
  /** 验证地址后在隔离窗口中打开外部链接。 */
  ipcMain.handle('shell:open-external', (event, url: string) => {
    assertTrustedSender(event)
    const externalUrl = getExternalUrl(url)
    if (!externalUrl) throw new Error('不支持的外部链接')
    createBrowserWindow(externalUrl)
  })
  /** 在 1 MB 资源上限内写入系统剪贴板。 */
  ipcMain.handle('clipboard:write-text', (event, text: string) => {
    assertTrustedSender(event)
    if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('复制内容无效')
    clipboard.writeText(text)
  })
  /** 将用户权限决策交给待决 Agent 请求。 */
  ipcMain.handle('permissions:respond', (event, input: PermissionResponseInput) => {
    assertTrustedSender(event)
    sessions.handlePermissionResponse(input)
  })
  /** 读取全部持久化会话。 */
  ipcMain.handle('sessions:list', (event) => {
    assertTrustedSender(event)
    return sessions.listSessions()
  })
  /** 创建会话并提交首条提示。 */
  ipcMain.handle('sessions:create', (event, input: StartSessionInput) => {
    assertTrustedSender(event)
    return sessions.createSession(input?.prompt, input?.title, input?.roleId)
  })
  /** 创建固定工作区的空会话，支持先添加附件再发送。 */
  ipcMain.handle('sessions:create-draft', (event, input?: CreateDraftSessionInput) => {
    assertTrustedSender(event)
    return sessions.createDraftSession('新会话', input?.roleId)
  })
  /** 读取指定会话的消息历史。 */
  ipcMain.handle('sessions:messages', (event, sessionId: string) => {
    assertTrustedSender(event)
    return sessions.getMessages(sessionId)
  })
  /** 向已有会话追加提示。 */
  ipcMain.handle('sessions:send', (event, input: SendMessageInput) => {
    assertTrustedSender(event)
    sessions.sendMessage(input?.sessionId, input?.prompt, input?.attachmentIds)
  })
  /** 取消会话的当前任务和排队任务。 */
  ipcMain.handle('sessions:cancel', (event, sessionId: string) => {
    assertTrustedSender(event)
    sessions.cancel(sessionId)
  })
  /** 删除会话及其消息。 */
  ipcMain.handle('sessions:delete', (event, sessionId: string) => {
    assertTrustedSender(event)
    sessions.deleteSession(sessionId)
  })
  /** 返回不包含明文密钥的公开配置。 */
  ipcMain.handle('config:get', (event) => {
    assertTrustedSender(event)
    return store.getPublicConfig()
  })
  /** 校验并持久化允许修改的应用配置。 */
  ipcMain.handle('config:save', (event, patch: AppConfigPatch) => {
    assertTrustedSender(event)
    if (!patch || typeof patch !== 'object') throw new Error('配置格式无效')
    return store.updateConfig(patch)
  })
  /** 使用原生目录选择器获取 Agent 工作目录。 */
  ipcMain.handle('config:select-directory', async (event) => {
    assertTrustedSender(event)
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Agent 工作目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] || null
  })
  /** 返回由主进程资源扫描和数据库状态合并的技能列表。 */
  ipcMain.handle('skills:list', (event) => {
    assertTrustedSender(event)
    return skills.listSkills()
  })
  /** 校验并持久化内置技能启用状态。 */
  ipcMain.handle('skills:set-enabled', (event, input: SetSkillEnabledInput) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('技能开关参数无效')
    return skills.setEnabled(input.id, input.enabled)
  })
  ipcMain.handle('skills:install-dependencies', async (event, input: InstallSkillDependenciesInput) => {
    assertTrustedSender(event)
    if (!input || typeof input.id !== 'string') throw new Error('技能依赖安装参数无效')
    if (!mainWindow) throw new Error('主窗口不可用')
    const missing = skills.getMissingCommandIds(input.id)
    if (!missing.length) return skills.listSkills()
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['取消', '安装'],
      defaultId: 1,
      cancelId: 0,
      title: '安装技能依赖',
      message: '需要安装系统级文档处理组件',
      detail: `即将通过系统程序包管理器安装：${missing.map(commandLabel).join('、')}。安装过程可能请求管理员权限。`
    })
    return result.response === 1 ? skills.installDependencies(input.id) : skills.listSkills()
  })
  /** 返回主进程资源中定义的角色，不暴露角色系统提示词。 */
  ipcMain.handle('roles:list', (event) => {
    assertTrustedSender(event)
    return roles.listRoles()
  })
  /** 导入结构化标准元数据；内容哈希和待审核状态由主进程生成。 */
  ipcMain.handle('knowledge:import-standard', (event, input: ManualStandardImport) => {
    assertTrustedSender(event)
    return knowledge.importStandard(input)
  })
  /** 更新标准核验状态，不向 Agent 暴露该能力。 */
  ipcMain.handle('knowledge:review-standard', (event, input: ReviewStandardInput) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('标准审核参数无效')
    return knowledge.reviewStandard(input.versionId, input.status)
  })
  /** 执行本地优先、官方白名单回退的标准查询。 */
  ipcMain.handle('knowledge:query-standard', (event, input: StandardQueryInput) => {
    assertTrustedSender(event)
    return knowledge.queryStandard(input)
  })
  /** 创建绑定会话持久化工作区的不可变标准快照。 */
  ipcMain.handle(
    'knowledge:create-project-snapshot',
    (event, input: CreateProjectStandardSnapshotInput) => {
      assertTrustedSender(event)
      return knowledge.createProjectSnapshot(input)
    }
  )
  ipcMain.handle('knowledge:latest-project-snapshot', (event, sessionId: string) => {
    assertTrustedSender(event)
    return knowledge.getLatestProjectSnapshot(sessionId)
  })
  /** 使用原生多选文件对话框并直接导入受控副本，不返回原始绝对路径。 */
  ipcMain.handle('attachments:select', async (event, sessionId: string) => {
    assertTrustedSender(event)
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '添加附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的文件',
          extensions: [
            'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'json', 'xml',
            'yaml', 'yml', 'toml', 'sql', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ts',
            'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'cs', 'html',
            'css', 'vue', 'svelte', 'sh'
          ]
        }
      ]
    })
    return result.canceled ? [] : attachments.importPaths(sessionId, result.filePaths)
  })
  /** 导入 preload 从拖拽 File 安全解析出的路径。 */
  ipcMain.handle('attachments:import-paths', (event, sessionId: string, paths: string[]) => {
    assertTrustedSender(event)
    return attachments.importPaths(sessionId, paths)
  })
  /** 导入没有本地路径的剪贴板图片字节。 */
  ipcMain.handle('attachments:import-bytes', (event, input: AttachmentBytesInput) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object') throw new Error('附件数据无效')
    return attachments.importBytes(input.sessionId, input.name, input.mimeType, input.bytes)
  })
  /** 只允许删除尚未绑定消息的附件。 */
  ipcMain.handle('attachments:discard', (event, attachmentId: string) => {
    assertTrustedSender(event)
    attachments.discard(attachmentId)
  })
  /** 只按数据库附件 ID 定位文件，不接受渲染进程提供的任意路径。 */
  ipcMain.handle('attachments:reveal', (event, attachmentId: string) => {
    assertTrustedSender(event)
    shell.showItemInFolder(attachments.getRevealPath(attachmentId))
  })
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  // 第二次启动仅激活已有主窗口，避免重复注册 IPC 和会话运行器。
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // 主窗口身份建立后再注册依赖发送方校验的 IPC。
  app.whenReady().then(() => {
    mainWindow = createWindow()
    const store = new AppStore()
    appStore = store
    const skills = new SkillsManager(store)
    const knowledge = new ConstructionKnowledgeService(store)
    knowledge.loadBuiltinMethodCards(
      join(skills.getPluginPath(), 'skills', 'municipal-construction-methods', 'cards')
    )
    const runner = new ClaudeAgentRunner(knowledge)
    const roles = new RolesManager()
    const attachments = new AttachmentManager(store)
    /** 将会话管理器事件单向转发给可信渲染进程。 */
    const sessions = new SessionManager(
      store,
      runner,
      (event: ServerEvent) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server:event', event)
      },
      skills,
      roles,
      attachments
    )
    registerIpc(store, sessions, skills, roles, attachments, knowledge)

    /** macOS 从 Dock 激活且无窗口时重建主窗口。 */
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

/** 非 macOS 平台关闭所有窗口即退出应用。 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** 在进程退出前同步关闭 SQLite，确保 WAL 内容完整落盘。 */
app.on('before-quit', () => {
  appStore?.close()
  appStore = null
})
