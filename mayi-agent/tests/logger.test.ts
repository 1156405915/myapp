import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLogDirectory,
  logError,
  logInfo,
  runWithLogContext
} from '../src/main/logging/logger'

let userDataRoot = ''

beforeEach(() => {
  userDataRoot = mkdtempSync(join(tmpdir(), 'mayi-logger-'))
  process.env.MAYI_USER_DATA_DIR = userDataRoot
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  delete process.env.MAYI_USER_DATA_DIR
  rmSync(userDataRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('持久化日志', () => {
  it('写入上下文并脱敏凭据字段', () => {
    runWithLogContext(
      { sessionId: 'session-123', traceId: 'trace-456', module: 'test' },
      () => logInfo('安全日志', { apiKey: 'secret-key', authorization: 'Bearer real-token' })
    )

    const content = readFileSync(join(getLogDirectory(), 'mayi-current.log'), 'utf8')
    expect(content).toContain('session-123')
    expect(content).toContain('trace-456')
    expect(content).toContain('安全日志')
    expect(content).toContain('[REDACTED]')
    expect(content).not.toContain('secret-key')
    expect(content).not.toContain('real-token')
  })

  it('活动日志达到大小上限后自动轮转', () => {
    logInfo('初始化日志')
    const logDirectory = getLogDirectory()
    writeFileSync(join(logDirectory, 'mayi-current.log'), Buffer.alloc(5 * 1024 * 1024, 65))

    logError('触发轮转')

    const files = readdirSync(logDirectory)
    expect(files).toContain('mayi-current.log')
    expect(files.some((name) => name.startsWith('mayi-20') && name.endsWith('.log'))).toBe(true)
    expect(readFileSync(join(logDirectory, 'mayi-current.log'), 'utf8')).toContain('触发轮转')
  })
})
