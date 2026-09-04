import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '../src/shared/protocol'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('../src/main/logging/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }))

import { MethodCardService } from '../src/main/knowledge/method-card-service'
import { AppStore } from '../src/main/store/app-store'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('市政工法卡服务', () => {
  it('加载内置工法卡并根据项目事实确定性匹配', () => {
    const store = new AppStore(temporaryDirectory('mayi-method-db-'))
    const service = new MethodCardService(store)
    const loaded = service.loadBuiltinCards(
      resolve('resources/skills-plugin/skills/municipal-construction-methods/cards')
    )
    expect(loaded).toHaveLength(7)

    const session: ChatSession = {
      id: 'method-session',
      title: '工法匹配',
      status: 'idle',
      cwd: temporaryDirectory('mayi-method-workspace-'),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const result = service.matchMethodCards({
      sessionId: session.id,
      disciplines: ['road', 'common'],
      factIds: [
        'entity.road',
        'work.subgrade',
        'design.road-structure',
        'site.geology',
        'quantity.earthwork'
      ],
      mode: 'draft'
    })
    expect(result.factsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.candidates[0]).toMatchObject({
      applicability: 'applicable',
      method: { id: 'municipal-road-subgrade-construction', reviewStatus: 'reviewed' }
    })
    store.close()
  })

  it('冻结草案工法快照并保留内置版本哈希', () => {
    const store = new AppStore(temporaryDirectory('mayi-method-snapshot-db-'))
    const workspace = temporaryDirectory('mayi-method-snapshot-workspace-')
    const session: ChatSession = {
      id: 'method-snapshot-session',
      title: '工法快照',
      status: 'idle',
      cwd: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const service = new MethodCardService(store)
    service.loadBuiltinCards(resolve('resources/skills-plugin/skills/municipal-construction-methods/cards'))
    const match = service.matchMethodCards({
      sessionId: session.id,
      disciplines: ['drainage'],
      factIds: ['entity.drainage', 'work.pipeline'],
      mode: 'draft'
    })
    const candidate = match.candidates[0]
    const snapshot = service.createProjectMethodSnapshot({
      sessionId: session.id,
      factsHash: match.factsHash,
      mode: 'draft',
      methods: [{ methodVersionId: candidate.method.versionId, selectionReason: 'entity' }]
    })
    expect(snapshot.revision).toBe(1)
    expect(snapshot.methods[0].contentHash).toBe(candidate.method.contentHash)
    const artifact = join(workspace, ...snapshot.artifactRelativePath.split('/'))
    expect(existsSync(artifact)).toBe(true)
    expect(JSON.parse(readFileSync(artifact, 'utf8')).snapshotHash).toBe(snapshot.snapshotHash)
    expect(service.getLatestProjectMethodSnapshot(session.id)).toEqual(snapshot)
    store.close()
  })

  it('正式模式不返回仅 reviewed 的内置卡片', () => {
    const store = new AppStore(temporaryDirectory('mayi-method-formal-db-'))
    const session: ChatSession = {
      id: 'method-formal-session',
      title: '正式匹配',
      status: 'idle',
      cwd: temporaryDirectory('mayi-method-formal-workspace-'),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const service = new MethodCardService(store)
    service.loadBuiltinCards(resolve('resources/skills-plugin/skills/municipal-construction-methods/cards'))
    const result = service.matchMethodCards({
      sessionId: session.id,
      disciplines: ['road'],
      factIds: ['entity.road', 'design.road-structure', 'site.geology', 'quantity.earthwork'],
      mode: 'formal'
    })
    expect(result.candidates).toEqual([])
    store.close()
  })
})
