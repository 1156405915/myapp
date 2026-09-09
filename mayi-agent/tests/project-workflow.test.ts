import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() } }))
vi.mock('../src/main/logging/logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))
import { AppStore } from '../src/main/store/app-store'
import { ProjectWorkflowService, type StageHandler } from '../src/main/workflow/project-workflow-service'
import { WORKFLOW_STAGES } from '../src/shared/workflow'

const resources: Array<{ store: AppStore; directory: string }> = []
afterEach(() => { for (const r of resources.splice(0)) { r.store.close(); rmSync(r.directory, { recursive: true, force: true }) } })
function setup(handler?: StageHandler) {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-project-workflow-'))
  const store = new AppStore(directory)
  resources.push({ store, directory })
  const handlers = handler ? Object.fromEntries(WORKFLOW_STAGES.map((s) => [s, handler])) : {}
  const service = new ProjectWorkflowService(store, directory, handlers)
  const p = service.createProject('测试工程')
  return { store, service, projectId: p.id, directory }
}
function sources(store: AppStore, projectId: string) {
  for (const category of ['tender', 'boq']) {
    const id = `${projectId}-${category}`
    store.prepareInternal('INSERT INTO documents VALUES (?, ?, ?, NULL, 1)').run(id, projectId, category)
    store.prepareInternal('INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)').run(`${id}-v`, id, projectId, `${category}.pdf`, 'a'.repeat(64), `sources/${id}`, 'application/pdf')
    store.prepareInternal('UPDATE documents SET active_version_id = ? WHERE id = ?').run(`${id}-v`, id)
  }
}
const handler: StageHandler = {
  execute: async ({ stage }) => ({ stage }),
  validate: async () => ({ valid: true, errors: [] }),
  publish: ({ stage }) => ({ stage })
}

describe('四阶段项目底座', () => {
  it('建立隔离项目目录且没有演示运行或成果', () => {
    const { service, projectId } = setup()
    expect(service.listProjects()).toHaveLength(1)
    const root = service.workspace(projectId)
    for (const d of ['sources', 'extracted', 'runs', 'deliverables']) expect(existsSync(join(root, d))).toBe(true)
    expect(service.listRuns(projectId)).toEqual([])
    expect(service.listArtifacts(projectId)).toEqual([])
    expect(() => service.createProject('  ')).toThrow('名称')
    expect(() => service.start(projectId)).toThrow('尚未接通')
  })

  it('资料不全不能启动，同项目不能创建两个活动运行', () => {
    const { service, store, projectId } = setup(handler)
    expect(() => service.start(projectId)).toThrow('请先登记')
    sources(store, projectId)
    service.start(projectId)
    expect(() => service.start(projectId)).toThrow('UNIQUE')
  })

  it('模型和验收返回成功也不能在缺少真实交付登记时完成', async () => {
    const { service, store, projectId } = setup(handler)
    sources(store, projectId)
    const runId = service.start(projectId)
    await expect(service.execute(projectId, runId)).rejects.toThrow('没有已登记成果')
    expect(service.listRuns(projectId)[0].status).toBe('failed')
    const rows = store.prepareInternal('SELECT stage_key,status FROM stage_runs WHERE workflow_run_id = ? ORDER BY created_at').all(runId)
    expect(rows.map((r) => r.stage_key)).toEqual([...WORKFLOW_STAGES])
    expect(rows.map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'failed'])
    expect(store.prepareInternal("SELECT COUNT(*) AS n FROM workflow_events WHERE type = 'run.succeeded'").get()!.n).toBe(0)
  })

  it('验收失败阻止后续阶段，重试新建尝试且保留失败记录', async () => {
    const invalid = { ...handler, validate: async () => ({ valid: false, errors: ['证据缺失'] }) }
    const { service, store, projectId } = setup(invalid)
    sources(store, projectId)
    const runId = service.start(projectId)
    for (let i = 0; i < 2; i++) await expect(service.execute(projectId, runId)).rejects.toThrow('证据缺失')
    const rows = store.prepareInternal('SELECT stage_key,attempt,status FROM stage_runs WHERE workflow_run_id = ? ORDER BY attempt').all(runId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.attempt)).toEqual([1, 2])
    expect(rows.every((r) => r.stage_key === 'requirements' && r.status === 'failed')).toBe(true)
  })

  it('输入版本改变后旧运行失效，跨项目读取被拒绝', async () => {
    const { service, store, projectId } = setup(handler)
    sources(store, projectId)
    const runId = service.start(projectId)
    store.prepareInternal('UPDATE projects SET input_revision = 1 WHERE id = ?').run(projectId)
    await expect(service.execute(projectId, runId)).rejects.toThrow('资料已更新')
    expect(service.listRuns(projectId)[0].status).toBe('stale')
    const other = service.createProject('其他工程')
    await expect(service.execute(other.id, runId)).rejects.toThrow('不属于当前项目')
    expect(() => service.resolveArtifact(other.id, 'unknown')).toThrow('成果不存在')
  })

  it('启动时将未完成工作流标为中断而不是成功', () => {
    const { service, store, projectId, directory } = setup(handler)
    sources(store, projectId)
    service.start(projectId)
    store.close()
    const reopened = new AppStore(directory)
    try {
      expect(reopened.prepareInternal('SELECT status FROM workflow_runs').get()!.status).toBe('interrupted')
    } finally { reopened.close() }
  })
})
