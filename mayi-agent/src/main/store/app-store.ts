import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  AppConfigPatch,
  ChatMessage,
  ChatSession,
  PublicAppConfig
} from '../../shared/protocol'

interface StoredConfig {
  model: string
  cwd: string
  encryptedApiKey?: string
}

interface StoredData {
  config: StoredConfig
  sessions: ChatSession[]
  messages: ChatMessage[]
}

const DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])

export class AppStore {
  private readonly filePath: string
  private data: StoredData

  constructor() {
    this.filePath = join(app.getPath('userData'), 'mayi-data.json')
    this.data = this.load()
  }

  private defaultData(): StoredData {
    return {
      config: {
        model: 'deepseek-v4-pro',
        cwd: app.getPath('documents')
      },
      sessions: [],
      messages: []
    }
  }

  private load(): StoredData {
    if (!existsSync(this.filePath)) return this.defaultData()

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredData>
      const fallback = this.defaultData()
      const storedConfig = { ...fallback.config, ...parsed.config }
      if (!DEEPSEEK_MODELS.has(storedConfig.model)) storedConfig.model = fallback.config.model
      return {
        config: storedConfig,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : []
      }
    } catch {
      return this.defaultData()
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8')
  }

  getPublicConfig(): PublicAppConfig {
    return {
      model: this.data.config.model,
      cwd: this.data.config.cwd,
      hasApiKey: Boolean(
        process.env.DEEPSEEK_API_KEY ||
          process.env.ANTHROPIC_AUTH_TOKEN ||
          this.data.config.encryptedApiKey
      )
    }
  }

  getRuntimeConfig(): PublicAppConfig & { apiKey: string } {
    let apiKey =
      process.env.DEEPSEEK_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || ''
    const encrypted = this.data.config.encryptedApiKey

    if (!apiKey && encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，无法读取 API Key')
      }
      apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    }

    return { ...this.getPublicConfig(), apiKey }
  }

  updateConfig(patch: AppConfigPatch): PublicAppConfig {
    if (patch.model !== undefined) {
      const model = patch.model.trim()
      if (!DEEPSEEK_MODELS.has(model)) throw new Error('不支持的 DeepSeek 模型')
      this.data.config.model = model
    }

    if (patch.cwd !== undefined) {
      const cwd = resolve(patch.cwd.trim())
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new Error('工作目录不存在或不是文件夹')
      }
      this.data.config.cwd = cwd
    }

    if (patch.apiKey !== undefined && patch.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，无法保存 API Key')
      }
      this.data.config.encryptedApiKey = safeStorage
        .encryptString(patch.apiKey.trim())
        .toString('base64')
    }

    this.persist()
    return this.getPublicConfig()
  }

  listSessions(): ChatSession[] {
    return [...this.data.sessions].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  getSession(sessionId: string): ChatSession | undefined {
    return this.data.sessions.find((session) => session.id === sessionId)
  }

  saveSession(session: ChatSession): void {
    const index = this.data.sessions.findIndex((item) => item.id === session.id)
    if (index >= 0) this.data.sessions[index] = session
    else this.data.sessions.push(session)
    this.persist()
  }

  deleteSession(sessionId: string): void {
    this.data.sessions = this.data.sessions.filter((session) => session.id !== sessionId)
    this.data.messages = this.data.messages.filter((message) => message.sessionId !== sessionId)
    this.persist()
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.data.messages
      .filter((message) => message.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  saveMessage(message: ChatMessage): void {
    this.data.messages.push(message)
    this.persist()
  }
}
