import { app, safeStorage } from 'electron'
import { createRequire } from 'node:module'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { logError, logInfo, logWarn } from '../logging/logger'
import { validateWorkspaceRoot } from '../security/workspace-guard'
import type {
  AppConfigPatch,
  AttachmentKind,
  ChatMessage,
  ChatSession,
  ContentBlock,
  MessageAttachment,
  PublicAppConfig
} from '../../shared/protocol'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
type DatabaseConnection = InstanceType<typeof DatabaseSync>

interface LegacyStoredConfig {
  baseUrl?: string
  model?: string
  cwd?: string
  encryptedApiKey?: string
}

interface LegacyStoredData {
  config?: LegacyStoredConfig
  sessions?: ChatSession[]
  messages?: Array<Omit<ChatMessage, 'blocks'> & { content?: string; blocks?: ContentBlock[] }>
}

interface SessionRow {
  id: string
  title: string
  status: ChatSession['status']
  cwd: string
  runtime_session_id: string | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  session_id: string
  role: ChatMessage['role']
  created_at: number
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  duration_ms: number | null
  context_used_tokens: number | null
  context_max_tokens: number | null
  is_error: number
}

interface ContentBlockRow {
  message_id: string
  block_json: string
}

interface AttachmentRow {
  id: string
  session_id: string
  message_id: string | null
  original_name: string
  relative_path: string
  mime_type: string
  kind: AttachmentKind
  size: number
  width: number | null
  height: number | null
  created_at: number
}

const DATABASE_VERSION = 3
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
const DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])

/** 仅允许 HTTPS，或用于本机开发的 HTTP 回环地址。 */
function normalizeBaseUrl(value: string): string {
  const candidate = value.trim() || DEFAULT_ANTHROPIC_BASE_URL
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('API Base URL 无效')
  }
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('API Base URL 必须使用 HTTPS，本机回环地址可使用 HTTP')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API Base URL 不能包含凭据、查询参数或片段')
  }
  return url.toString().replace(/\/$/, '')
}

export class AppStore {
  private readonly dataDirectory: string
  private readonly databasePath: string
  private readonly legacyPath: string
  private database!: DatabaseConnection
  private transactionDepth = 0
  private closed = false

  /** 打开数据库，完成完整性检查、版本迁移和旧版 JSON 导入。 */
  constructor(dataDirectory = app.getPath('userData')) {
    this.dataDirectory = dataDirectory
    this.databasePath = join(dataDirectory, 'mayi.db')
    this.legacyPath = join(dataDirectory, 'mayi-data.json')
    mkdirSync(dataDirectory, { recursive: true })
    this.database = this.openWithRecovery()
    this.configureDatabase()
    this.migrateDatabase()
    this.importLegacyData()
    this.ensureDefaultConfig()
    this.recoverInterruptedSessions()
    this.createBackup()
  }

  /** 打开数据库并在文件损坏时优先从最近备份恢复。 */
  private openWithRecovery(): DatabaseConnection {
    let database: DatabaseConnection | undefined
    try {
      database = new DatabaseSync(this.databasePath)
      const integrity = database.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined
      if (integrity?.integrity_check !== 'ok') throw new Error('SQLite 完整性检查失败')
      return database
    } catch (error) {
      database?.close()
      logError('SQLite 数据库打开失败，正在执行恢复', error)
      const corruptPath = `${this.databasePath}.corrupt-${Date.now()}`
      try {
        if (existsSync(this.databasePath)) renameSync(this.databasePath, corruptPath)
        const backup = this.findLatestBackup()
        if (backup) copyFileSync(backup, this.databasePath)
        const recovered = new DatabaseSync(this.databasePath)
        const integrity = recovered.prepare('PRAGMA integrity_check').get() as
          | { integrity_check?: string }
          | undefined
        if (integrity?.integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败')
        logWarn(backup ? '已从 SQLite 备份恢复数据库' : '已创建新的 SQLite 数据库', {
          backup,
          corruptPath
        })
        return recovered
      } catch (recoveryError) {
        logError('SQLite 数据库恢复失败', recoveryError)
        throw recoveryError
      }
    }
  }

  /** 启用外键、WAL 和忙等待，降低异常退出与并发写入风险。 */
  private configureDatabase(): void {
    this.database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;'
    )
  }

  /** 按 user_version 顺序执行幂等迁移，并用事务保证原子性。 */
  private migrateDatabase(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version > DATABASE_VERSION) throw new Error('数据库版本高于当前应用支持版本')
    if (row.user_version === DATABASE_VERSION) return

    this.transaction(() => {
      if (row.user_version < 1) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'error')),
            cwd TEXT NOT NULL,
            runtime_session_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            created_at INTEGER NOT NULL,
            model TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cost_usd REAL,
            duration_ms INTEGER,
            context_used_tokens INTEGER,
            context_max_tokens INTEGER,
            is_error INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS content_blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            block_index INTEGER NOT NULL,
            block_type TEXT NOT NULL,
            block_json TEXT NOT NULL,
            UNIQUE(message_id, block_index)
          );
          CREATE TABLE IF NOT EXISTS trace_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            step_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(message_id, step_index)
          );
          CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at, id);
          CREATE INDEX IF NOT EXISTS idx_blocks_message_index ON content_blocks(message_id, block_index);
          CREATE INDEX IF NOT EXISTS idx_trace_message_index ON trace_steps(message_id, step_index);
          PRAGMA user_version = 1;
        `)
      }
      if (row.user_version < 2) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS skill_states (
            skill_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            updated_at INTEGER NOT NULL
          );
          PRAGMA user_version = 2;
        `)
      }
      if (row.user_version < 3) {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
            original_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('image', 'document', 'text')),
            size INTEGER NOT NULL,
            width INTEGER,
            height INTEGER,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, relative_path)
          );
          CREATE INDEX IF NOT EXISTS idx_attachments_session_message
            ON attachments(session_id, message_id);
          PRAGMA user_version = 3;
        `)
      }
    })
    logInfo('SQLite 数据库迁移完成', { version: DATABASE_VERSION })
  }

  /** 将旧版整体 JSON 在单个事务中导入，并保留原文件备份。 */
  private importLegacyData(): void {
    if (!existsSync(this.legacyPath) || this.getSetting('legacy_imported') === '1') return

    try {
      const parsed = JSON.parse(readFileSync(this.legacyPath, 'utf8')) as LegacyStoredData
      this.transaction(() => {
        if (parsed.config?.model && DEEPSEEK_MODELS.has(parsed.config.model)) {
          this.setSetting('model', parsed.config.model)
        }
        if (parsed.config?.baseUrl) {
          this.setSetting('base_url', normalizeBaseUrl(parsed.config.baseUrl))
        }
        if (parsed.config?.cwd) this.setSetting('cwd', resolve(parsed.config.cwd))
        if (parsed.config?.encryptedApiKey) {
          this.setSetting('encrypted_api_key', parsed.config.encryptedApiKey)
        }

        for (const session of parsed.sessions || []) this.saveSession(session)
        for (const legacyMessage of parsed.messages || []) {
          const blocks = legacyMessage.blocks?.length
            ? legacyMessage.blocks
            : [{ type: 'text', text: legacyMessage.content || '' } satisfies ContentBlock]
          this.saveMessage({ ...legacyMessage, blocks })
        }
        this.setSetting('legacy_imported', '1')
      })
      renameSync(this.legacyPath, `${this.legacyPath}.migrated-${Date.now()}.bak`)
      logInfo('旧版 JSON 数据已迁移到 SQLite')
    } catch (error) {
      logError('旧版 JSON 数据迁移失败', error)
      throw error
    }
  }

  /** 确保首次启动拥有合法模型和默认工作目录。 */
  private ensureDefaultConfig(): void {
    if (!this.getSetting('base_url')) this.setSetting('base_url', DEFAULT_ANTHROPIC_BASE_URL)
    if (!DEEPSEEK_MODELS.has(this.getSetting('model') || '')) {
      this.setSetting('model', 'deepseek-v4-pro')
    }
    if (!this.getSetting('cwd')) this.setSetting('cwd', app.getPath('documents'))
  }

  /** 将异常退出时残留的运行态恢复为可再次执行的空闲态。 */
  private recoverInterruptedSessions(): void {
    const result = this.database
      .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'")
      .run(Date.now())
    if (result.changes > 0) logWarn('已恢复异常中断的会话状态', { count: result.changes })
  }

  /** 在数据库一致快照上创建轮换备份，最多保留三个。 */
  private createBackup(): void {
    if (!existsSync(this.databasePath) || statSync(this.databasePath).size === 0) return
    const backupPath = join(this.dataDirectory, `mayi-${Date.now()}.db.bak`)
    try {
      const escapedPath = backupPath.replaceAll("'", "''")
      this.database.exec(`VACUUM INTO '${escapedPath}'`)
      const backups = this.listBackups()
      for (const stale of backups.slice(3)) unlinkSync(stale)
    } catch (error) {
      logWarn('SQLite 备份创建失败', error)
    }
  }

  /** 返回按修改时间从新到旧排列的数据库备份。 */
  private listBackups(): string[] {
    return readdirSync(this.dataDirectory)
      .filter((name) => /^mayi-\d+\.db\.bak$/.test(name))
      .map((name) => join(this.dataDirectory, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  }

  /** 查找最新可恢复备份。 */
  private findLatestBackup(): string | undefined {
    return this.listBackups()[0]
  }

  /** 用显式事务包装多表写入，并在异常时完整回滚。 */
  private transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation()
    this.database.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  /** 读取单项配置值。 */
  private getSetting(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /** 插入或覆盖单项配置值。 */
  private setSetting(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  /** 返回不含明文密钥的公开配置。 */
  getPublicConfig(): PublicAppConfig {
    const encryptedApiKey = this.getSetting('encrypted_api_key')
    return {
      baseUrl: this.getSetting('base_url') || DEFAULT_ANTHROPIC_BASE_URL,
      model: this.getSetting('model') || 'deepseek-v4-pro',
      cwd: this.getSetting('cwd') || app.getPath('documents'),
      hasApiKey: Boolean(
        process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || encryptedApiKey
      )
    }
  }

  /** 解密主进程运行所需的 API Key，不向数据库保存明文。 */
  getRuntimeConfig(): PublicAppConfig & { apiKey: string } {
    let apiKey =
      process.env.DEEPSEEK_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim() || ''
    const encrypted = this.getSetting('encrypted_api_key')
    if (!apiKey && encrypted) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API Key')
      apiKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    }
    return { ...this.getPublicConfig(), apiKey }
  }

  /** 校验并以事务保存公开配置补丁。 */
  updateConfig(patch: AppConfigPatch): PublicAppConfig {
    this.transaction(() => {
      if (patch.baseUrl !== undefined) {
        this.setSetting('base_url', normalizeBaseUrl(patch.baseUrl))
      }
      if (patch.model !== undefined) {
        const model = patch.model.trim()
        if (!DEEPSEEK_MODELS.has(model)) throw new Error('不支持的 DeepSeek 模型')
        this.setSetting('model', model)
      }
      if (patch.cwd !== undefined) {
        const cwd = resolve(patch.cwd.trim())
        const validation = validateWorkspaceRoot(cwd)
        if (!validation.allowed) throw new Error(validation.reason || '工作目录无效')
        this.setSetting('cwd', cwd)
        logInfo('默认工作目录已更新', { cwd })
      }
      if (patch.apiKey !== undefined && patch.apiKey.trim()) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API Key')
        this.setSetting(
          'encrypted_api_key',
          safeStorage.encryptString(patch.apiKey.trim()).toString('base64')
        )
      }
    })
    return this.getPublicConfig()
  }

  /** 返回用户明确覆盖过的技能启用状态。 */
  listSkillStates(): Record<string, boolean> {
    const rows = this.database
      .prepare('SELECT skill_id, enabled FROM skill_states')
      .all() as unknown as Array<{ skill_id: string; enabled: number }>
    return Object.fromEntries(rows.map((row) => [row.skill_id, Boolean(row.enabled)]))
  }

  /** 插入或更新单个技能的用户启用状态。 */
  setSkillEnabled(skillId: string, enabled: boolean): void {
    if (typeof skillId !== 'string' || !skillId.trim() || typeof enabled !== 'boolean') {
      throw new Error('技能状态无效')
    }
    this.database
      .prepare(`
        INSERT INTO skill_states(skill_id, enabled, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(skill_id) DO UPDATE SET
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `)
      .run(skillId.trim(), enabled ? 1 : 0, Date.now())
  }

  /** 保存由主进程验证并复制完成的待发送附件。 */
  saveAttachment(sessionId: string, attachment: MessageAttachment): void {
    if (!this.getSession(sessionId)) throw new Error('附件所属会话不存在')
    this.database
      .prepare(`
        INSERT INTO attachments(
          id, session_id, message_id, original_name, relative_path, mime_type,
          kind, size, width, height, created_at
        ) VALUES(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        sessionId,
        attachment.name,
        attachment.relativePath,
        attachment.mimeType,
        attachment.kind,
        attachment.size,
        attachment.width ?? null,
        attachment.height ?? null,
        Date.now()
      )
  }

  /** 按会话读取附件快照，可选择只允许尚未绑定消息的附件。 */
  getAttachments(sessionId: string, attachmentIds: string[], pendingOnly = false): MessageAttachment[] {
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 10) throw new Error('附件列表无效')
    const uniqueIds = [...new Set(attachmentIds)]
    if (uniqueIds.length !== attachmentIds.length) throw new Error('附件列表包含重复项')
    if (uniqueIds.length === 0) return []

    const placeholders = uniqueIds.map(() => '?').join(', ')
    const rows = this.database
      .prepare(`
        SELECT * FROM attachments
        WHERE session_id = ? AND id IN (${placeholders})${pendingOnly ? ' AND message_id IS NULL' : ''}
      `)
      .all(sessionId, ...uniqueIds) as unknown as AttachmentRow[]
    const byId = new Map(rows.map((row) => [row.id, this.mapAttachment(row)]))
    const attachments = uniqueIds.map((id) => byId.get(id)).filter(Boolean) as MessageAttachment[]
    if (attachments.length !== uniqueIds.length) throw new Error('附件不存在、已发送或不属于当前会话')
    return attachments
  }

  /** 按主键读取附件，供受控删除和资源管理器定位使用。 */
  getAttachment(attachmentId: string): (MessageAttachment & { sessionId: string; pending: boolean }) | undefined {
    const row = this.database.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId) as
      | AttachmentRow
      | undefined
    return row
      ? { ...this.mapAttachment(row), sessionId: row.session_id, pending: row.message_id === null }
      : undefined
  }

  /** 删除未绑定消息的附件记录；已发送附件不可由草稿操作删除。 */
  deletePendingAttachment(attachmentId: string): boolean {
    return this.database
      .prepare('DELETE FROM attachments WHERE id = ? AND message_id IS NULL')
      .run(attachmentId).changes === 1
  }

  /** 返回最近更新优先的全部会话。 */
  listSessions(): ChatSession[] {
    return (
      this.database.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[]
    ).map((row) => this.mapSession(row))
  }

  /** 按主键读取单个会话。 */
  getSession(sessionId: string): ChatSession | undefined {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | SessionRow
      | undefined
    return row ? this.mapSession(row) : undefined
  }

  /** 原子插入或更新会话，并记录其工作区。 */
  saveSession(session: ChatSession): void {
    this.database
      .prepare(`
        INSERT INTO sessions(id, title, status, cwd, runtime_session_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          cwd = excluded.cwd,
          runtime_session_id = excluded.runtime_session_id,
          updated_at = excluded.updated_at
      `)
      .run(
        session.id,
        session.title,
        session.status,
        session.cwd,
        session.runtimeSessionId || null,
        session.createdAt,
        session.updatedAt
      )
  }

  /** 删除会话，依靠外键级联清理消息、内容块和 Trace。 */
  deleteSession(sessionId: string): void {
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }

  /** 读取消息及其有序结构化内容块。 */
  listMessages(sessionId: string): ChatMessage[] {
    const messages = this.database
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id')
      .all(sessionId) as unknown as MessageRow[]
    const blockStatement = this.database.prepare(
      'SELECT message_id, block_json FROM content_blocks WHERE message_id = ? ORDER BY block_index'
    )
    return messages.map((row) => {
      const blocks = (blockStatement.all(row.id) as unknown as ContentBlockRow[]).map(
        (block) => JSON.parse(block.block_json) as ContentBlock
      )
      return this.mapMessage(row, blocks)
    })
  }

  /** 在事务中保存消息、内容块和可查询 Trace 步骤。 */
  saveMessage(message: ChatMessage, attachmentIds: string[] = []): void {
    this.transaction(() => {
      const attachments = this.getAttachments(message.sessionId, attachmentIds, true)
      this.database
        .prepare(`
          INSERT INTO messages(
            id, session_id, role, created_at, model, input_tokens, output_tokens, cost_usd,
            duration_ms, context_used_tokens, context_max_tokens, is_error
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          message.id,
          message.sessionId,
          message.role,
          message.createdAt,
          message.model || null,
          message.tokenUsage?.input ?? null,
          message.tokenUsage?.output ?? null,
          message.tokenUsage?.costUsd ?? null,
          message.durationMs ?? null,
          message.contextUsage?.usedTokens ?? null,
          message.contextUsage?.maxTokens ?? null,
          message.isError ? 1 : 0
        )
      const insertBlock = this.database.prepare(
        'INSERT INTO content_blocks(message_id, block_index, block_type, block_json) VALUES(?, ?, ?, ?)'
      )
      const insertTrace = this.database.prepare(
        'INSERT INTO trace_steps(message_id, step_index, kind, payload_json, created_at) VALUES(?, ?, ?, ?, ?)'
      )
      message.blocks.forEach((block, index) => {
        const payload = JSON.stringify(block)
        insertBlock.run(message.id, index, block.type, payload)
        if (block.type !== 'text' && block.type !== 'attachment') {
          insertTrace.run(message.id, index, block.type, payload, message.createdAt)
        }
      })
      const bindAttachment = this.database.prepare(
        'UPDATE attachments SET message_id = ? WHERE id = ? AND session_id = ? AND message_id IS NULL'
      )
      for (const attachment of attachments) {
        const result = bindAttachment.run(message.id, attachment.id, message.sessionId)
        if (result.changes !== 1) throw new Error('附件绑定消息失败')
      }
    })
  }

  /** 关闭数据库连接，供应用退出和隔离测试释放文件句柄。 */
  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  /** 将数据库会话行转换为共享协议实体。 */
  private mapSession(row: SessionRow): ChatSession {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      cwd: row.cwd,
      runtimeSessionId: row.runtime_session_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  /** 将数据库消息行与内容块组合为共享协议实体。 */
  private mapMessage(row: MessageRow, blocks: ContentBlock[]): ChatMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      blocks,
      createdAt: row.created_at,
      model: row.model || undefined,
      tokenUsage:
        row.input_tokens !== null && row.output_tokens !== null
          ? {
              input: row.input_tokens,
              output: row.output_tokens,
              costUsd: row.cost_usd ?? undefined
            }
          : undefined,
      durationMs: row.duration_ms ?? undefined,
      contextUsage:
        row.context_used_tokens !== null && row.context_max_tokens !== null
          ? { usedTokens: row.context_used_tokens, maxTokens: row.context_max_tokens }
          : undefined,
      isError: Boolean(row.is_error)
    }
  }

  /** 将附件存储行转换为不包含绝对源路径的共享实体。 */
  private mapAttachment(row: AttachmentRow): MessageAttachment {
    return {
      id: row.id,
      name: row.original_name,
      kind: row.kind,
      mimeType: row.mime_type,
      size: row.size,
      relativePath: row.relative_path,
      width: row.width ?? undefined,
      height: row.height ?? undefined
    }
  }
}
