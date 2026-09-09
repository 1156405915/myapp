import { app, safeStorage } from 'electron'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logInfo, logWarn } from '../logging/logger'
import { PROJECT_SCHEMA } from './project-schema'
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

interface SessionRow {
  id: string
  title: string
  status: ChatSession['status']
  cwd: string
  role_id: string | null
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

const DATABASE_VERSION = 1
const DATABASE_APPLICATION_ID = 0x4d415949
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
  private database!: DatabaseConnection
  private transactionDepth = 0
  private closed = false

  // 新架构数据库不读取旧库、JSON 或历史备份。
  constructor(dataDirectory = app.getPath('userData')) {
    this.dataDirectory = dataDirectory
    this.databasePath = join(dataDirectory, 'mayi-projects-v1.db')
    mkdirSync(dataDirectory, { recursive: true })
    this.database = new DatabaseSync(this.databasePath)
    try {
      this.assertDatabaseIdentity()
      this.configureDatabase()
      this.initializeDatabase()
      this.ensureDefaultConfig()
      this.recoverInterruptedSessions()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  private assertDatabaseIdentity(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number }
    const identity = this.database.prepare('PRAGMA application_id').get() as { application_id: number }
    const tables = this.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    if (version.user_version === 0 && tables.length === 0 && identity.application_id === 0) return
    if (version.user_version !== DATABASE_VERSION || identity.application_id !== DATABASE_APPLICATION_ID) {
      throw new Error('项目数据库身份或版本不受支持；不导入旧数据')
    }
    const check = this.database.prepare('PRAGMA quick_check').get() as { quick_check: string }
    if (check.quick_check !== 'ok') throw new Error('项目数据库完整性检查失败')
  }

  /** 启用外键、WAL 和忙等待，降低异常退出与并发写入风险。 */
  private configureDatabase(): void {
    this.database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;'
    )
  }

  private initializeDatabase(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version !== 0 && row.user_version !== DATABASE_VERSION) throw new Error('项目数据库版本不受支持')
    if (row.user_version === DATABASE_VERSION) return

    this.transaction(() => {
      this.database.exec(PROJECT_SCHEMA)
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id),
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'error')),
            cwd TEXT NOT NULL,
            role_id TEXT,
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
        `)
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS skill_states (
            skill_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
            updated_at INTEGER NOT NULL
          );
        `)
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
        `)
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS standard_registry (
            id TEXT PRIMARY KEY,
            normalized_code TEXT NOT NULL,
            display_code TEXT NOT NULL,
            title TEXT NOT NULL,
            level TEXT NOT NULL CHECK(level IN (
              'national', 'industry', 'anhui', 'hefei', 'group', 'enterprise'
            )),
            jurisdiction_json TEXT NOT NULL,
            disciplines_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(normalized_code, jurisdiction_json)
          );
          CREATE TABLE IF NOT EXISTS standard_versions (
            id TEXT PRIMARY KEY,
            standard_id TEXT NOT NULL REFERENCES standard_registry(id),
            status TEXT NOT NULL CHECK(status IN (
              'active', 'revised', 'superseded', 'abolished', 'unknown'
            )),
            mandatory_nature TEXT NOT NULL CHECK(mandatory_nature IN (
              'mandatory', 'recommended', 'partially-mandatory', 'unknown'
            )),
            verification_status TEXT NOT NULL CHECK(verification_status IN (
              'discovered', 'pending_review', 'verified_official', 'approved',
              'superseded', 'abolished', 'rejected'
            )),
            publish_date TEXT,
            effective_date TEXT,
            abolished_date TEXT,
            replaces_json TEXT NOT NULL DEFAULT '[]',
            replaced_by_json TEXT NOT NULL DEFAULT '[]',
            official_source_id TEXT NOT NULL,
            official_source_url TEXT NOT NULL,
            full_text_access TEXT NOT NULL CHECK(full_text_access IN (
              'public', 'licensed', 'metadata-only'
            )),
            source_hash TEXT NOT NULL,
            checked_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(standard_id, effective_date, source_hash)
          );
          CREATE TABLE IF NOT EXISTS standard_queries (
            id TEXT PRIMARY KEY,
            query_key TEXT NOT NULL UNIQUE,
            normalized_code TEXT NOT NULL,
            jurisdiction TEXT NOT NULL,
            discipline TEXT,
            applicable_date TEXT NOT NULL,
            source_id TEXT NOT NULL,
            result_status TEXT NOT NULL CHECK(result_status IN ('found', 'not_found', 'failed')),
            resolved_version_id TEXT REFERENCES standard_versions(id),
            response_hash TEXT,
            response_summary_json TEXT,
            queried_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            error_code TEXT
          );
          CREATE TABLE IF NOT EXISTS project_standard_snapshots (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            workspace_canonical_path TEXT NOT NULL,
            applicable_date TEXT NOT NULL,
            mode TEXT NOT NULL CHECK(mode IN ('draft', 'formal')),
            revision INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            artifact_relative_path TEXT NOT NULL,
            artifact_state TEXT NOT NULL DEFAULT 'ready'
              CHECK(artifact_state IN ('pending', 'ready', 'missing', 'hash_mismatch')),
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, revision),
            UNIQUE(session_id, snapshot_hash)
          );
          CREATE TABLE IF NOT EXISTS project_standard_snapshot_items (
            snapshot_id TEXT NOT NULL REFERENCES project_standard_snapshots(id) ON DELETE CASCADE,
            version_id TEXT NOT NULL REFERENCES standard_versions(id),
            selection_reason TEXT NOT NULL CHECK(selection_reason IN (
              'tender', 'design', 'mandatory', 'regional', 'method'
            )),
            verification_status TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            PRIMARY KEY(snapshot_id, version_id, selection_reason)
          );
          CREATE INDEX IF NOT EXISTS idx_standard_version_applicable
            ON standard_versions(standard_id, effective_date, abolished_date, verification_status);
          CREATE INDEX IF NOT EXISTS idx_standard_version_checked
            ON standard_versions(checked_at);
          CREATE INDEX IF NOT EXISTS idx_standard_query_expiry
            ON standard_queries(query_key, expires_at);
          CREATE INDEX IF NOT EXISTS idx_project_snapshot_session
            ON project_standard_snapshots(session_id, revision DESC);
        `)
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS method_cards (
            id TEXT PRIMARY KEY,
            discipline TEXT NOT NULL,
            name TEXT NOT NULL,
            builtin INTEGER NOT NULL CHECK(builtin IN (0, 1)),
            current_version_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS method_card_versions (
            id TEXT PRIMARY KEY,
            method_card_id TEXT NOT NULL REFERENCES method_cards(id),
            schema_version INTEGER NOT NULL,
            version TEXT NOT NULL,
            content_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            review_status TEXT NOT NULL CHECK(review_status IN (
              'draft', 'reviewed', 'approved', 'retired', 'rejected'
            )),
            source_kind TEXT NOT NULL CHECK(source_kind IN ('builtin', 'enterprise', 'project')),
            reviewed_at TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(method_card_id, version, content_hash)
          );
          CREATE TABLE IF NOT EXISTS method_standard_refs (
            method_version_id TEXT NOT NULL REFERENCES method_card_versions(id) ON DELETE CASCADE,
            standard_version_id TEXT REFERENCES standard_versions(id),
            normalized_code TEXT NOT NULL,
            clause_ref TEXT NOT NULL DEFAULT '',
            purpose TEXT NOT NULL CHECK(purpose IN ('constraint', 'quality', 'safety', 'acceptance', 'test')),
            required INTEGER NOT NULL CHECK(required IN (0, 1)),
            resolution_status TEXT NOT NULL CHECK(resolution_status IN ('resolved', 'unresolved', 'conflicting')),
            PRIMARY KEY(method_version_id, normalized_code, clause_ref, purpose)
          );
          CREATE TABLE IF NOT EXISTS project_method_snapshots (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            created_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            revision INTEGER NOT NULL,
            facts_hash TEXT NOT NULL,
            standard_snapshot_id TEXT REFERENCES project_standard_snapshots(id),
            mode TEXT NOT NULL CHECK(mode IN ('draft', 'formal')),
            snapshot_json TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            artifact_relative_path TEXT NOT NULL,
            artifact_state TEXT NOT NULL CHECK(artifact_state IN ('pending', 'ready', 'missing', 'hash_mismatch')),
            created_at INTEGER NOT NULL,
            UNIQUE(project_id, revision),
            UNIQUE(project_id, snapshot_hash)
          );
          CREATE TABLE IF NOT EXISTS project_method_snapshot_items (
            snapshot_id TEXT NOT NULL REFERENCES project_method_snapshots(id) ON DELETE CASCADE,
            method_version_id TEXT NOT NULL REFERENCES method_card_versions(id),
            selection_reason TEXT NOT NULL CHECK(selection_reason IN ('entity', 'risk', 'tender', 'design', 'user')),
            PRIMARY KEY(snapshot_id, method_version_id)
          );
          CREATE INDEX IF NOT EXISTS idx_method_cards_discipline ON method_cards(discipline);
          CREATE INDEX IF NOT EXISTS idx_method_versions_status ON method_card_versions(review_status);
          CREATE INDEX IF NOT EXISTS idx_method_refs_code ON method_standard_refs(normalized_code);
          CREATE INDEX IF NOT EXISTS idx_project_method_snapshot_project
            ON project_method_snapshots(project_id, revision DESC);
        `)
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS official_sync_runs (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'partial', 'failed')),
            discovered_count INTEGER NOT NULL DEFAULT 0,
            not_found_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            error_summary TEXT
          );
          CREATE TABLE IF NOT EXISTS official_source_records (
            id TEXT PRIMARY KEY,
            sync_run_id TEXT REFERENCES official_sync_runs(id) ON DELETE SET NULL,
            provider_id TEXT NOT NULL,
            record_type TEXT NOT NULL CHECK(record_type IN (
              'catalog', 'announcement', 'amendment', 'abolition', 'replacement', 'document'
            )),
            external_id TEXT NOT NULL,
            requested_url TEXT NOT NULL,
            final_url TEXT NOT NULL,
            content_type TEXT NOT NULL,
            content_length INTEGER NOT NULL,
            response_hash TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            review_status TEXT NOT NULL CHECK(review_status IN ('pending_review', 'approved', 'rejected')),
            fetched_at INTEGER NOT NULL,
            UNIQUE(provider_id, external_id, response_hash)
          );
          CREATE TABLE IF NOT EXISTS standard_documents (
            id TEXT PRIMARY KEY,
            standard_version_id TEXT NOT NULL REFERENCES standard_versions(id),
            document_type TEXT NOT NULL CHECK(document_type IN (
              'official_fulltext', 'amendment', 'announcement', 'explanation'
            )),
            access_type TEXT NOT NULL CHECK(access_type IN ('public', 'licensed', 'metadata-only')),
            source_record_id TEXT REFERENCES official_source_records(id),
            media_type TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            content_hash TEXT NOT NULL,
            storage_key TEXT,
            parse_status TEXT NOT NULL CHECK(parse_status IN (
              'not_requested', 'pending', 'parsed', 'unsupported', 'failed'
            )),
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS standard_clauses (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES standard_documents(id) ON DELETE CASCADE,
            clause_type TEXT NOT NULL CHECK(clause_type IN (
              'chapter', 'section', 'clause', 'table', 'appendix', 'explanation'
            )),
            clause_no TEXT NOT NULL,
            title TEXT,
            text TEXT NOT NULL,
            page_start INTEGER,
            page_end INTEGER,
            content_hash TEXT NOT NULL,
            review_status TEXT NOT NULL CHECK(review_status IN ('pending_review', 'approved', 'rejected')),
            UNIQUE(document_id, clause_no, content_hash)
          );
          CREATE INDEX IF NOT EXISTS idx_official_records_review
            ON official_source_records(review_status, fetched_at DESC);
          CREATE INDEX IF NOT EXISTS idx_standard_clauses_number
            ON standard_clauses(document_id, clause_no);
        `)
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS standard_validation_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            input_hash TEXT NOT NULL,
            standard_snapshot_id TEXT REFERENCES project_standard_snapshots(id),
            status TEXT NOT NULL CHECK(status IN ('passed', 'warnings', 'blocked')),
            report_json TEXT NOT NULL,
            artifact_relative_path TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS standard_validation_issues (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES standard_validation_runs(id) ON DELETE CASCADE,
            rule_code TEXT NOT NULL,
            severity TEXT NOT NULL CHECK(severity IN ('blocking', 'high', 'medium', 'low')),
            status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'accepted')),
            reference_index INTEGER NOT NULL,
            message TEXT NOT NULL,
            suggestion TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS knowledge_impacts (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            trigger_type TEXT NOT NULL CHECK(trigger_type IN ('standard_status', 'standard_version', 'method_card')),
            trigger_entity_id TEXT NOT NULL,
            target_type TEXT NOT NULL CHECK(target_type IN (
              'method_card', 'project_standard_snapshot', 'project_method_snapshot'
            )),
            target_id TEXT NOT NULL,
            impact_type TEXT NOT NULL CHECK(impact_type IN ('revalidate', 'reselect', 'regenerate', 'review_only')),
            severity TEXT NOT NULL CHECK(severity IN ('high', 'medium', 'low')),
            reason TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('open', 'acknowledged', 'resolved', 'not_applicable')),
            detected_at INTEGER NOT NULL,
            resolved_at INTEGER,
            UNIQUE(trigger_type, trigger_entity_id, target_type, target_id, impact_type, status)
          );
          CREATE TABLE IF NOT EXISTS knowledge_reviews (
            id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL CHECK(entity_type IN ('standard_version', 'method_version', 'official_record')),
            entity_id TEXT NOT NULL,
            previous_status TEXT,
            decision TEXT NOT NULL,
            reviewer_type TEXT NOT NULL CHECK(reviewer_type IN ('user', 'builtin_release', 'system')),
            reason TEXT NOT NULL,
            evidence_refs_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS knowledge_retrieval_events (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            query_type TEXT NOT NULL CHECK(query_type IN ('standard', 'method', 'reference_validation')),
            query_hash TEXT NOT NULL,
            filters_json TEXT NOT NULL,
            candidate_ids_json TEXT NOT NULL,
            selected_ids_json TEXT NOT NULL DEFAULT '[]',
            zero_result INTEGER NOT NULL CHECK(zero_result IN (0, 1)),
            latency_ms INTEGER NOT NULL,
            manual_override INTEGER NOT NULL DEFAULT 0 CHECK(manual_override IN (0, 1)),
            feedback TEXT NOT NULL DEFAULT 'unknown' CHECK(feedback IN ('relevant', 'partial', 'irrelevant', 'unknown')),
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_validation_project ON standard_validation_runs(project_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_impacts_project_status ON knowledge_impacts(project_id, status, detected_at DESC);
          CREATE INDEX IF NOT EXISTS idx_retrieval_type_created ON knowledge_retrieval_events(query_type, created_at DESC);
          PRAGMA user_version = 1;
        `)
        this.database.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_ID}`)
    })
    logInfo('项目数据库初始化完成', { version: DATABASE_VERSION })
  }

  /** 确保首次启动拥有合法模型和默认工作目录。 */
  private ensureDefaultConfig(): void {
    if (!this.getSetting('base_url')) this.setSetting('base_url', DEFAULT_ANTHROPIC_BASE_URL)
    if (!DEEPSEEK_MODELS.has(this.getSetting('model') || '')) {
      this.setSetting('model', 'deepseek-v4-pro')
    }
    const workspace = join(this.dataDirectory, 'assistant-workspace')
    mkdirSync(workspace, { recursive: true })
    if (!this.getSetting('cwd')) this.setSetting('cwd', workspace)
  }

  /** 将异常退出时残留的运行态恢复为可再次执行的空闲态。 */
  private recoverInterruptedSessions(): void {
    this.transaction(() => {
      this.database.prepare("UPDATE stage_runs SET status = 'interrupted', updated_at = ? WHERE status IN ('pending','running','validating')").run(Date.now())
      this.database.prepare("UPDATE workflow_runs SET status = 'interrupted', updated_at = ? WHERE status IN ('pending','running')").run(Date.now())
    })
    const result = this.database
      .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'")
      .run(Date.now())
    if (result.changes > 0) logWarn('已恢复异常中断的会话状态', { count: result.changes })
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

  /** 仅供受信主进程仓储准备参数化语句，不向渲染器或 Agent 暴露。 */
  prepareInternal(sql: string): ReturnType<DatabaseConnection['prepare']> {
    return this.database.prepare(sql)
  }

  /** 允许受信主进程领域服务复用数据库原子事务。 */
  runInTransaction<T>(operation: () => T): T {
    return this.transaction(operation)
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
        INSERT INTO sessions(id, title, status, cwd, role_id, runtime_session_id, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          cwd = excluded.cwd,
          role_id = excluded.role_id,
          runtime_session_id = excluded.runtime_session_id,
          updated_at = excluded.updated_at
      `)
      .run(
        session.id,
        session.title,
        session.status,
        session.cwd,
        session.roleId || null,
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
      roleId: row.role_id || undefined,
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
