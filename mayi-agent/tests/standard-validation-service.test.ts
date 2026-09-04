import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
vi.mock('../src/main/logging/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }))

import { ConstructionKnowledgeService } from '../src/main/knowledge/construction-knowledge-service'
import { StandardValidationService } from '../src/main/knowledge/standard-validation-service'
import { AppStore } from '../src/main/store/app-store'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function standard(): ManualStandardImport {
  return {
    code: 'GB 55003-2021',
    title: '建筑与市政地基基础通用规范',
    level: 'national',
    jurisdictions: ['CN', 'Hefei'],
    disciplines: ['municipal'],
    status: 'active',
    mandatoryNature: 'mandatory',
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

describe('工程标准引用校验', () => {
  it('按正式快照校验编号、名称和条款可验证性', () => {
    const store = new AppStore(temporaryDirectory('mayi-validation-db-'))
    const workspace = temporaryDirectory('mayi-validation-workspace-')
    const session: ChatSession = {
      id: 'validation-session',
      title: '引用校验',
      status: 'idle',
      cwd: workspace,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const knowledge = new ConstructionKnowledgeService(store)
    const imported = knowledge.importStandard(standard())
    const verified = knowledge.reviewStandard(imported.id, 'verified_official', '已核对官方元数据')
    knowledge.createProjectSnapshot({
      sessionId: session.id,
      applicableDate: '2026-09-04',
      mode: 'formal',
      standards: [{ versionId: verified.id, selectionReason: 'mandatory' }]
    })

    const validation = new StandardValidationService(store)
    const report = validation.validateReferences({
      sessionId: session.id,
      applicableDate: '2026-09-04',
      mode: 'formal',
      references: [{
        rawCode: 'GB55003—2021',
        rawTitle: '错误的标准名称',
        clauseRef: '3.1.1',
        sourceType: 'chapter',
        sourceId: 'chapter-1',
        sourceLocation: '第一章'
      }]
    })
    expect(report.status).toBe('warnings')
    expect(report.issues.map((issue) => issue.ruleCode)).toEqual([
      'standard_title_mismatch',
      'clause_unverified'
    ])
    expect(existsSync(join(workspace, ...report.artifactRelativePath.split('/')))).toBe(true)
    store.close()
  })

  it('正式引用不在项目快照时阻断', () => {
    const store = new AppStore(temporaryDirectory('mayi-validation-missing-db-'))
    const session: ChatSession = {
      id: 'validation-missing-session',
      title: '缺失引用',
      status: 'idle',
      cwd: temporaryDirectory('mayi-validation-missing-workspace-'),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    store.saveSession(session)
    const report = new StandardValidationService(store).validateReferences({
      sessionId: session.id,
      applicableDate: '2026-09-04',
      mode: 'formal',
      references: [{
        rawCode: 'CJJ 1-2099',
        sourceType: 'planning',
        sourceId: 'plan-1'
      }]
    })
    expect(report.status).toBe('blocked')
    expect(report.issues.map((issue) => issue.ruleCode)).toEqual(
      expect.arrayContaining(['formal_snapshot_missing', 'standard_not_in_snapshot'])
    )
    store.close()
  })
})
