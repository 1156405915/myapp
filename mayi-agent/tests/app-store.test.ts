import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession } from '../src/shared/protocol'

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
  it('将旧版 JSON 会话和纯文本消息事务迁移为结构化内容块', () => {
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
    expect(store.getPublicConfig().model).toBe('deepseek-v4-flash')
    expect(store.listSessions()).toHaveLength(1)
    expect(store.listMessages('legacy-session')[0].blocks).toEqual([
      { type: 'text', text: '旧版文本' }
    ])
    store.close()

    const files = readdirSync(directory)
    expect(files.some((name) => name.startsWith('mayi-data.json.migrated-'))).toBe(true)
    expect(files.some((name) => name.endsWith('.db.bak'))).toBe(true)
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
      expect(reopened.listMessages(session.id)).toEqual([message])
    } finally {
      reopened.close()
    }
  })

  it('数据库损坏时从最近完整备份恢复', () => {
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
      expect(readdirSync(directory).some((name) => name.includes('.corrupt-'))).toBe(true)
    } finally {
      recovered.close()
    }
  })
})
