import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession, ManualStandardImport } from '../src/shared/protocol'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('../src/main/logging/logger', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}))

import {
  ConstructionKnowledgeService,
  type OfficialStandardProvider
} from '../src/main/knowledge/construction-knowledge-service'
import { AppStore } from '../src/main/store/app-store'

const temporaryDirectories: string[] = []

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function standardImport(code = 'GB 55003—2021'): ManualStandardImport {
  return {
    code,
    title: '建筑与市政地基基础通用规范',
    level: 'national',
    jurisdictions: ['CN', 'Hefei'],
    disciplines: ['municipal'],
    status: 'active',
    mandatoryNature: 'mandatory',
    publishDate: '2021-09-08',
    effectiveDate: '2022-01-01',
    officialSourceId: 'national-standard-platform',
    officialSourceUrl: 'https://std.samr.gov.cn/example',
    fullTextAccess: 'metadata-only'
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('工程标准知识服务', () => {
  it('导入记录默认待审核，正式快照仅接受已核验版本', async () => {
    const dataDirectory = createTemporaryDirectory('mayi-knowledge-db-')
    const workspace = createTemporaryDirectory('mayi-knowledge-workspace-')
    const store = new AppStore(dataDirectory)
    const session: ChatSession = {
      id: 'knowledge-session',
      title: '标准快照',
      status: 'idle',
      cwd: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const service = new ConstructionKnowledgeService(store)

    const imported = service.importStandard(standardImport())
    expect(imported.normalizedCode).toBe('GB55003-2021')
    expect(imported.verificationStatus).toBe('pending_review')
    expect(imported.sourceHash).toMatch(/^[0-9a-f]{64}$/)

    const query = await service.queryStandard({
      code: 'GB55003-2021',
      jurisdiction: 'Hefei',
      discipline: 'municipal',
      applicableDate: '2026-09-04',
      purpose: 'formal'
    })
    expect(query.cacheState).toBe('hit')
    expect(query.usableForFormal).toBe(false)
    expect(() =>
      service.createProjectSnapshot({
        sessionId: session.id,
        applicableDate: '2026-09-04',
        mode: 'formal',
        standards: [{ versionId: imported.id, selectionReason: 'mandatory' }]
      })
    ).toThrow('未核验')

    const reviewed = service.reviewStandard(imported.id, 'verified_official')
    const snapshot = service.createProjectSnapshot({
      sessionId: session.id,
      applicableDate: '2026-09-04',
      mode: 'formal',
      standards: [{ versionId: reviewed.id, selectionReason: 'mandatory' }]
    })
    expect(snapshot.revision).toBe(1)
    expect(snapshot.standards[0]).toMatchObject({
      versionId: reviewed.id,
      verificationStatus: 'verified_official'
    })
    const artifactPath = join(workspace, ...snapshot.artifactRelativePath.split('/'))
    expect(existsSync(artifactPath)).toBe(true)
    expect(JSON.parse(readFileSync(artifactPath, 'utf8')).snapshotHash).toBe(snapshot.snapshotHash)
    expect(service.getLatestProjectSnapshot(session.id)).toEqual(snapshot)
    store.close()
  })

  it('同一查询并发时只访问一次官方 Provider，并把新记录置为待审核', async () => {
    const dataDirectory = createTemporaryDirectory('mayi-knowledge-lock-')
    const store = new AppStore(dataDirectory)
    let calls = 0
    const provider: OfficialStandardProvider = {
      id: 'national-standard-platform',
      supports: () => true,
      lookup: async () => {
        calls += 1
        await Promise.resolve()
        return standardImport('GB/T 1234-2020')
      }
    }
    const service = new ConstructionKnowledgeService(store, [provider])
    const input = {
      code: 'GB/T 1234-2020',
      jurisdiction: 'CN',
      discipline: 'municipal',
      applicableDate: '2026-09-04',
      purpose: 'draft' as const
    }

    const [left, right] = await Promise.all([
      service.queryStandard(input),
      service.queryStandard(input)
    ])
    expect(calls).toBe(1)
    expect(left.version?.verificationStatus).toBe('pending_review')
    expect(right.version?.id).toBe(left.version?.id)
    store.close()
  })

  it('本地和 Provider 均未命中时使用负缓存', async () => {
    const dataDirectory = createTemporaryDirectory('mayi-knowledge-negative-')
    const store = new AppStore(dataDirectory)
    let calls = 0
    const provider: OfficialStandardProvider = {
      id: 'national-standard-platform',
      supports: () => true,
      lookup: async () => {
        calls += 1
        return undefined
      }
    }
    const service = new ConstructionKnowledgeService(store, [provider])
    const input = {
      code: 'CJJ 1-2099',
      jurisdiction: 'CN',
      applicableDate: '2026-09-04',
      purpose: 'draft' as const
    }

    expect((await service.queryStandard(input)).cacheState).toBe('miss')
    expect((await service.queryStandard(input)).cacheState).toBe('negative_hit')
    expect(calls).toBe(1)
    store.close()
  })

  it('拒绝非白名单官方来源', () => {
    const dataDirectory = createTemporaryDirectory('mayi-knowledge-source-')
    const store = new AppStore(dataDirectory)
    const service = new ConstructionKnowledgeService(store)
    expect(() =>
      service.importStandard({
        ...standardImport(),
        officialSourceUrl: 'https://std.samr.gov.cn.evil.test/example'
      })
    ).toThrow('白名单')
    store.close()
  })

  it('增量同步官方元数据并保持待审核状态', async () => {
    const dataDirectory = createTemporaryDirectory('mayi-knowledge-sync-')
    const store = new AppStore(dataDirectory)
    const provider: OfficialStandardProvider = {
      id: 'national-standard-platform',
      supports: () => true,
      lookup: async () => undefined,
      sync: async () => [{
        externalId: 'GB55003-2021',
        requestedUrl: 'https://std.samr.gov.cn/catalog',
        finalUrl: 'https://std.samr.gov.cn/catalog',
        contentType: 'application/json; charset=utf-8',
        contentLength: 128,
        responseHash: 'a'.repeat(64),
        fetchedAt: Date.now(),
        metadata: standardImport()
      }]
    }
    const service = new ConstructionKnowledgeService(store, [provider])
    const run = await service.syncOfficialMetadata('national-standard-platform', {
      codes: ['GB 55003-2021'],
      jurisdiction: 'CN',
      discipline: 'municipal',
      applicableDate: '2026-09-04'
    })
    expect(run).toMatchObject({ status: 'succeeded', discovered: 1, failed: 0 })
    const result = await service.queryStandard({
      code: 'GB55003-2021',
      jurisdiction: 'CN',
      discipline: 'municipal',
      applicableDate: '2026-09-04',
      purpose: 'draft'
    })
    expect(result.version?.verificationStatus).toBe('pending_review')
    expect(result.version?.sourceHash).toBe('a'.repeat(64))
    store.close()
  })
})
