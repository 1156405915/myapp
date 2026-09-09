import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession, MessageAttachment } from '../src/shared/protocol'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'documents' ? process.cwd() : process.cwd())
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

vi.mock('../src/main/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}))

import { AppStore } from '../src/main/store/app-store'

const temporaryDirectories: string[] = []

/** 创建并登记测试结束后需要清理的临时数据目录。 */
function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-store-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AppStore SQLite 持久化', () => {
  it('默认使用 DeepSeek Base URL，并持久化合法的自定义地址', () => {
    const directory = createTemporaryDirectory()
    const store = new AppStore(directory)

    expect(store.getPublicConfig().baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(store.updateConfig({ baseUrl: 'https://api.example.com/anthropic/' }).baseUrl).toBe(
      'https://api.example.com/anthropic'
    )
    expect(() => store.updateConfig({ baseUrl: 'http://api.example.com' })).toThrow(
      '必须使用 HTTPS'
    )
    store.close()

    const reopened = new AppStore(directory)
    try {
      expect(reopened.getPublicConfig().baseUrl).toBe('https://api.example.com/anthropic')
      expect(reopened.updateConfig({ baseUrl: '' }).baseUrl).toBe(
        'https://api.deepseek.com/anthropic'
      )
    } finally {
      reopened.close()
    }
  })

  it('持久化单个技能的用户启用状态', () => {
    const directory = createTemporaryDirectory()
    const store = new AppStore(directory)
    store.setSkillEnabled('document-summary', false)
    store.setSkillEnabled('pdf', true)
    expect(store.listSkillStates()).toEqual({ 'document-summary': false, pdf: true })
    store.close()

    const reopened = new AppStore(directory)
    try {
      expect(reopened.listSkillStates()).toEqual({ 'document-summary': false, pdf: true })
    } finally {
      reopened.close()
    }
  })

  it('持久化会话选择的角色', () => {
    const directory = createTemporaryDirectory()
    const now = Date.now()
    const store = new AppStore(directory)
    store.saveSession({
      id: 'role-session',
      title: '施组编制',
      status: 'idle',
      cwd: process.cwd(),
      roleId: 'construction-organization-expert',
      createdAt: now,
      updatedAt: now
    })
    store.close()

    const reopened = new AppStore(directory)
    try {
      expect(reopened.getSession('role-session')?.roleId).toBe('construction-organization-expert')
    } finally {
      reopened.close()
    }
  })

  it('不导入旧版 JSON 会话、消息或配置', () => {
    const directory = createTemporaryDirectory()
    const now = Date.now()
    writeFileSync(
      join(directory, 'mayi-data.json'),
      JSON.stringify({
        config: { model: 'deepseek-v4-flash', cwd: process.cwd() },
        sessions: [
          {
            id: 'legacy-session',
            title: '旧会话',
            status: 'idle',
            cwd: process.cwd(),
            createdAt: now,
            updatedAt: now
          }
        ],
        messages: [
          {
            id: 'legacy-message',
            sessionId: 'legacy-session',
            role: 'assistant',
            content: '旧版文本',
            createdAt: now,
            model: 'legacy-model'
          }
        ]
      }),
      'utf8'
    )

    const store = new AppStore(directory)
    expect(store.getPublicConfig().model).toBe('deepseek-v4-pro')
    expect(store.listSessions()).toHaveLength(0)
    expect(store.listMessages('legacy-session')).toEqual([])
    store.close()

    const files = readdirSync(directory)
    expect(files).toContain('mayi-data.json')
    expect(files).toContain('mayi-projects-v1.db')
    expect(files.some((name) => name.startsWith('mayi-data.json.migrated-'))).toBe(false)
  })

  it('恢复结构化 Trace、用量和耗时', () => {
    const directory = createTemporaryDirectory()
    const now = Date.now()
    const session: ChatSession = {
      id: 'structured-session',
      title: '结构化会话',
      status: 'idle',
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now
    }
    const message: ChatMessage = {
      id: 'structured-message',
      sessionId: session.id,
      role: 'assistant',
      blocks: [
        { type: 'thinking', thinking: '分析任务' },
        { type: 'tool_use', toolUseId: 'tool-1', toolName: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_result', toolUseId: 'tool-1', content: '文件内容' },
        { type: 'text', text: '完成' }
      ],
      createdAt: now,
      model: 'test-model',
      tokenUsage: { input: 120, output: 30, costUsd: 0.01 },
      contextUsage: { usedTokens: 150, maxTokens: 1000 },
      durationMs: 2345,
      isError: false
    }

    const store = new AppStore(directory)
    store.saveSession(session)
    store.saveMessage(message)
    store.close()

    const reopened = new AppStore(directory)
    try {
      expect(reopened.listMessages(session.id)).toEqual([expect.objectContaining(message)])
    } finally {
      reopened.close()
    }
  })

  it('持久化附件并在同一事务中绑定到用户消息', () => {
    const directory = createTemporaryDirectory()
    const now = Date.now()
    const session: ChatSession = {
      id: 'attachment-session',
      title: '附件会话',
      status: 'idle',
      cwd: process.cwd(),
      createdAt: now,
      updatedAt: now
    }
    const attachment: MessageAttachment = {
      id: 'attachment-id',
      name: '合同.pdf',
      kind: 'document',
      mimeType: 'application/pdf',
      size: 1024,
      relativePath: '.mayi/attachments/attachment-session/attachment-id.pdf'
    }
    const message: ChatMessage = {
      id: 'attachment-message',
      sessionId: session.id,
      role: 'user',
      blocks: [
        { type: 'text', text: '请总结' },
        { type: 'attachment', attachment }
      ],
      createdAt: now
    }

    const store = new AppStore(directory)
    store.saveSession(session)
    store.saveAttachment(session.id, attachment)
    expect(store.getAttachments(session.id, [attachment.id], true)).toEqual([attachment])
    store.saveMessage(message, [attachment.id])
    expect(() => store.getAttachments(session.id, [attachment.id], true)).toThrow('已发送')
    store.close()

    const reopened = new AppStore(directory)
    try {
      expect(reopened.listMessages(session.id)).toEqual([expect.objectContaining(message)])
      expect(reopened.getAttachment(attachment.id)).toMatchObject({
        ...attachment,
        sessionId: session.id,
        pending: false
      })
    } finally {
      reopened.close()
    }
  })

  it('拒绝跨会话绑定附件', () => {
    const directory = createTemporaryDirectory()
    const store = new AppStore(directory)
    const now = Date.now()
    const left: ChatSession = {
      id: 'left-session', title: '左', status: 'idle', cwd: process.cwd(), createdAt: now, updatedAt: now
    }
    const right: ChatSession = {
      id: 'right-session', title: '右', status: 'idle', cwd: process.cwd(), createdAt: now, updatedAt: now
    }
    store.saveSession(left)
    store.saveSession(right)
    store.saveAttachment(left.id, {
      id: 'left-attachment',
      name: 'a.txt',
      kind: 'text',
      mimeType: 'text/plain',
      size: 1,
      relativePath: '.mayi/attachments/left-session/a.txt'
    })
    expect(() => store.getAttachments(right.id, ['left-attachment'], true)).toThrow('不属于当前会话')
    store.close()
  })

  it('不会因同目录旧数据库损坏而恢复旧历史', () => {
    const directory = createTemporaryDirectory()
    const session: ChatSession = {
      id: 'recovery-session',
      title: '恢复会话',
      status: 'idle',
      cwd: process.cwd(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    const initial = new AppStore(directory)
    initial.saveSession(session)
    initial.close()
    const backupCreator = new AppStore(directory)
    backupCreator.close()
    writeFileSync(join(directory, 'mayi.db'), 'not-a-sqlite-database', 'utf8')

    const recovered = new AppStore(directory)
    try {
      expect(recovered.getSession(session.id)).toMatchObject({ id: session.id, title: session.title })
      expect(readdirSync(directory).some((name) => name.includes('.corrupt-'))).toBe(false)
    } finally {
      recovered.close()
    }
  })

  it('新数据库损坏时明确失败，不从旧备份恢复', () => {
    const directory = createTemporaryDirectory()
    writeFileSync(join(directory, 'mayi-projects-v1.db'), 'broken')
    writeFileSync(join(directory, 'mayi-1.db.bak'), 'legacy')
    expect(() => new AppStore(directory)).toThrow()
  })

  it('从零建立项目表并在重启后保留项目数据', () => {
    const directory = createTemporaryDirectory()
    const store = new AppStore(directory)
    store.prepareInternal('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('p1', '项目', 'workspaces/p1', 0, 1, 1)
    const tables = store.prepareInternal("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining(['projects', 'documents', 'document_versions', 'document_chunks', 'workflow_runs', 'stage_runs', 'requirements', 'boq_items', 'construction_groups', 'sections', 'artifacts', 'workflow_events']))
    store.close()
    const reopened = new AppStore(directory)
    try {
      expect(reopened.prepareInternal('SELECT name FROM projects WHERE id = ?').get('p1')?.name).toBe('项目')
    } finally {
      reopened.close()
    }
  })

  it('拒绝身份不匹配的旧 schema 而不修改其版本', () => {
    const directory = createTemporaryDirectory()
    const store = new AppStore(directory)
    store.prepareInternal('PRAGMA application_id = 0').run()
    store.close()
    expect(() => new AppStore(directory)).toThrow('不导入旧数据')
  })

  it('外键拒绝跨项目绑定资料版本', () => {
    const store = new AppStore(createTemporaryDirectory())
    try {
      for (const id of ['left', 'right']) {
        store.prepareInternal('INSERT INTO projects VALUES (?, ?, ?, 0, 1, 1)').run(id, id, `workspaces/${id}`)
        store.prepareInternal("INSERT INTO documents VALUES (?, ?, 'boq', NULL, 1)").run(`doc-${id}`, id)
      }
      expect(() => store.prepareInternal('INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('v1', 'doc-left', 'right', '清单.xls', 'a'.repeat(64), 'sources/v1.xls', 'application/vnd.ms-excel', 1, 1)).toThrow('FOREIGN KEY')
    } finally {
      store.close()
    }
  })
})
