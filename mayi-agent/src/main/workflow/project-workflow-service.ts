import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AppStore } from '../store/app-store'
import { validateWorkspacePath, validateWorkspaceRoot } from '../security/workspace-guard'
import { WORKFLOW_STAGES, type ProjectSummary, type WorkflowSummary, type ArtifactSummary, type WorkflowStage } from '../../shared/workflow'

// 数据库行保留存储字段，面向界面的摘要不暴露工作区路径。
interface ProjectRow { id: string; name: string; workspace_relpath: string; input_revision: number; created_at: number; updated_at: number }
interface RunRow { id: string; project_id: string; status: WorkflowSummary['status']; mode: 'draft' | 'formal'; input_revision: number; input_manifest_json: string; updated_at: number }
// 处理器只获得本次冻结资料清单和已发布上游结果，不以聊天历史作为流程状态。
export interface StageContext { projectId: string; runId: string; stageRunId: string; stage: WorkflowStage; inputManifest: unknown; upstream: Record<string, unknown>; signal: AbortSignal }
// 业务实现由主进程注入；此接口本身不包含招标分析、清单解析或文档生成能力。
export interface StageHandler {
  // 耗时分析和文件准备在数据库事务外执行，处理器需要主动响应 signal。
  execute(context: StageContext): Promise<unknown>
  // 候选输出必须经过可信业务校验，不能仅凭模型自报成功放行。
  validate(context: StageContext, output: unknown): Promise<{ valid: boolean; errors: string[] }>
  // 在同步事务内登记已验收结果；不得在此发起异步任务，文件副作用也不会随数据库回滚。
  publish(context: StageContext, output: unknown): Record<string, unknown>
}

// 主进程编排底座：管理项目与运行，但不负责附件导入，也未内置四阶段生产处理器。
export class ProjectWorkflowService {
  // 仅追踪当前服务实例内的执行；持久化状态和同项目并发约束仍由数据库承担。
  private readonly active = new Map<string, AbortController>()

  // 空处理器配置允许查询项目，但 start 和 execute 会明确拒绝业务执行。
  constructor(private readonly store: AppStore, private readonly dataDirectory: string, private readonly handlers: Partial<Record<WorkflowStage, StageHandler>> = {}) {}

  // 项目名称只用于展示，UUID 决定存储位置；建项目不会自动创建会话或导入资料。
  createProject(name: unknown): ProjectSummary {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || /[\u0000-\u001f]/u.test(name)) throw new Error('项目名称无效')
    const id = randomUUID()
    const relpath = `workspaces/${id}`
    // 建目录前检查父路径边界，避免现有链接将写入导向应用目录之外。
    const boundary = validateWorkspacePath(this.dataDirectory, relpath, true)
    if (!boundary.allowed) throw new Error(boundary.reason)
    const root = join(this.dataDirectory, relpath)
    mkdirSync(root, { recursive: true })
    const check = validateWorkspaceRoot(root)
    if (!check.allowed) throw new Error(check.reason)
    for (const directory of ['sources', 'extracted', 'runs', 'deliverables']) mkdirSync(join(root, directory))
    const now = Date.now()
    // 文件系统与 SQLite 不共享事务，此处入库失败仍可能留下尚未登记的目录。
    this.store.prepareInternal('INSERT INTO projects VALUES (?, ?, ?, 0, ?, ?)').run(id, name.trim(), relpath, now, now)
    return this.listProjects().find((project) => project.id === id)!
  }

  // 只返回持久化项目摘要，不从磁盘目录推断项目或填充演示记录。
  listProjects(): ProjectSummary[] {
    return (this.store.prepareInternal('SELECT * FROM projects ORDER BY updated_at DESC, id').all() as unknown as ProjectRow[])
      .map((p) => ({ id: p.id, name: p.name, inputRevision: p.input_revision, createdAt: p.created_at, updatedAt: p.updated_at }))
  }

  // 项目存在性检查集中在主进程，不能把前端当前选中项当成有效数据库记录。
  private project(id: string): ProjectRow {
    const row = this.store.prepareInternal('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
    if (!row) throw new Error('项目不存在')
    return row
  }

  // 根据已登记相对路径解析真实目录，调用方不能自行指定任意工作区。
  workspace(projectId: string): string {
    const p = this.project(projectId)
    const validation = validateWorkspacePath(this.dataDirectory, p.workspace_relpath)
    if (!validation.allowed) throw new Error(validation.reason)
    const root = realpathSync(join(this.dataDirectory, p.workspace_relpath))
    if (!statSync(root).isDirectory()) throw new Error('项目工作区不是目录')
    return root
  }

  // 历史运行包含失败和中断记录，供界面如实展示而非只展示成功结果。
  listRuns(projectId: string): WorkflowSummary[] {
    this.project(projectId)
    return (this.store.prepareInternal('SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC, id').all(projectId) as unknown as RunRow[])
      .map((r) => ({ id: r.id, projectId: r.project_id, status: r.status, mode: r.mode, inputRevision: r.input_revision, updatedAt: r.updated_at }))
  }

  // 列表展示登记状态，不代表磁盘文件仍完好；打开前必须调用 resolveArtifact。
  listArtifacts(projectId: string): ArtifactSummary[] {
    this.project(projectId)
    return this.store.prepareInternal('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC, id').all(projectId).map((row) => ({
      id: String(row.id), projectId, kind: String(row.kind), name: basename(String(row.storage_relpath)), size: Number(row.byte_size), status: row.status as ArtifactSummary['status'], createdAt: Number(row.created_at)
    }))
  }

  // 只解析当前项目的已发布成果；此方法不打开文件，扩展名限制由调用入口另行检查。
  resolveArtifact(projectId: string, artifactId: string): string {
    const row = this.store.prepareInternal("SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND status = 'ready'").get(artifactId, projectId)
    if (!row) throw new Error('成果不存在、不属于当前项目或尚未发布')
    const root = this.workspace(projectId)
    const relativePath = String(row.storage_relpath)
    if (!relativePath.startsWith('deliverables/')) throw new Error('成果不在交付目录')
    const validation = validateWorkspacePath(root, relativePath)
    if (!validation.allowed) throw new Error(validation.reason)
    const path = realpathSync(join(root, relativePath))
    const stat = statSync(path)
    // 大小与哈希用于发现发布后被替换或损坏的文件，不代替文档内容和版式验收。
    if (!stat.isFile() || stat.size !== Number(row.byte_size) || stat.size > 100 * 1024 * 1024) throw new Error('成果文件大小或类型不匹配')
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== row.sha256) throw new Error('成果文件哈希不匹配')
    return path
  }

  // 只创建 pending 运行并返回 ID，不自动调用 execute；草稿/正式差异需业务处理器落实。
  start(projectId: string, mode: 'draft' | 'formal' = 'draft'): string {
    if (!['draft', 'formal'].includes(mode)) throw new Error('运行模式无效')
    const missing = WORKFLOW_STAGES.filter((stage) => !this.handlers[stage])
    if (missing.length) throw new Error(`阶段执行器尚未接通：${missing.join('、')}`)
    return this.store.runInTransaction(() => {
      const p = this.project(projectId)
      // 当前仅检查有效资料登记是否齐备，尚未检查解析覆盖率或类别确认状态。
      const documents = this.store.prepareInternal(`SELECT d.id, d.category, v.id AS versionId, v.sha256 FROM documents d JOIN document_versions v ON v.id = d.active_version_id WHERE d.project_id = ? ORDER BY d.id`).all(projectId)
      if (!documents.some((d) => d.category === 'tender') || !documents.some((d) => d.category === 'boq')) throw new Error('请先登记招标正文及工程量清单有效版本')
      const id = randomUUID()
      const now = Date.now()
      // 冻结版本及哈希而非复制文件内容；同项目单活动运行由数据库唯一索引约束。
      this.store.prepareInternal('INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, p.input_revision, JSON.stringify(documents), mode, 'pending', now, now)
      this.event(projectId, id, null, 'run.created', {})
      return id
    })
  }

  // 联合查询项目和运行 ID，防止仅凭运行 ID 访问其他项目记录。
  private run(projectId: string, runId: string): RunRow {
    const row = this.store.prepareInternal('SELECT * FROM workflow_runs WHERE id = ? AND project_id = ?').get(runId, projectId) as unknown as RunRow | undefined
    if (!row) throw new Error('运行不存在或不属于当前项目')
    return row
  }

  // 显式执行或重试已有运行；失败会向调用方抛出，不在内部自动循环重试。
  async execute(projectId: string, runId: string): Promise<void> {
    const run = this.run(projectId, runId)
    if (this.active.has(runId) || !['pending', 'failed', 'interrupted', 'waiting_user'].includes(run.status)) throw new Error('运行状态不允许执行')
    if (WORKFLOW_STAGES.some((stage) => !this.handlers[stage])) throw new Error('阶段执行器尚未接通')
    // 输入修订变化后拒绝继续旧运行，避免新资料与旧阶段结果混用。
    if (this.project(projectId).input_revision !== run.input_revision) {
      this.store.prepareInternal("UPDATE workflow_runs SET status = 'stale', updated_at = ? WHERE id = ?").run(Date.now(), runId)
      throw new Error('项目资料已更新，请创建新运行')
    }
    // 此处只检查阻断问题，尚未实现创建确认请求并主动进入 waiting_user 的完整流程。
    const unresolved = this.store.prepareInternal("SELECT id FROM issues WHERE workflow_run_id = ? AND severity = 'blocking' AND status = 'open' LIMIT 1").get(runId)
    if (unresolved) throw new Error('存在未处理阻断问题')
    const controller = new AbortController()
    this.store.prepareInternal("UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), runId)
    this.active.set(runId, controller)
    let stageRunId: string | null = null
    const upstream: Record<string, unknown> = {}
    try {
      for (const stage of WORKFLOW_STAGES) {
        controller.signal.throwIfAborted()
        // 重试复用已成功阶段的输出清单，目前尚未重新校验对应文件及处理器版本。
        const completed = this.store.prepareInternal("SELECT output_manifest_json FROM stage_runs WHERE workflow_run_id = ? AND stage_key = ? AND status = 'succeeded' ORDER BY attempt DESC LIMIT 1").get(runId, stage)
        if (completed) { upstream[stage] = JSON.parse(String(completed.output_manifest_json)); continue }
        // 每阶段最多三次尝试，包含首次执行；失败记录保留，不覆盖为新尝试。
        const attempt = Number(this.store.prepareInternal('SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM stage_runs WHERE workflow_run_id = ? AND stage_key = ?').get(runId, stage)!.next)
        if (attempt > 3) throw new Error('阶段重试次数已达上限')
        stageRunId = randomUUID()
        const now = Date.now()
        // 当前指纹用于记录输入身份，尚未纳入技能、解析器和模板版本。
        const fingerprint = createHash('sha256').update(JSON.stringify({ input: run.input_manifest_json, stage, upstream })).digest('hex')
        this.store.runInTransaction(() => {
          // 恢复时结束旧等待尝试，以新尝试承接执行而非改写旧尝试的输出。
          this.store.prepareInternal("UPDATE stage_runs SET status = 'interrupted', updated_at = ? WHERE workflow_run_id = ? AND status = 'waiting_user'").run(now, runId)
          this.store.prepareInternal("INSERT INTO stage_runs VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?)").run(stageRunId!, runId, projectId, stage, attempt, fingerprint, now, now)
          this.event(projectId, runId, stageRunId, 'stage.started', { stage, attempt })
        })
        // 克隆上游结果避免处理器意外改写编排器内存；这不是不可信代码的安全沙箱。
        const context: StageContext = { projectId, runId, stageRunId, stage, inputManifest: JSON.parse(run.input_manifest_json), upstream: structuredClone(upstream), signal: controller.signal }
        const handler = this.handlers[stage]!
        // 此处没有内置超时或模型预算，不响应取消且不返回的处理器会持续占用本次执行。
        const output = await handler.execute(context)
        // 拒绝取消后迟到的执行结果，避免其继续进入验收和发布。
        controller.signal.throwIfAborted()
        this.store.prepareInternal("UPDATE stage_runs SET status = 'validating', updated_at = ? WHERE id = ?").run(Date.now(), stageRunId)
        const check = await handler.validate(context, output)
        controller.signal.throwIfAborted()
        if (!check.valid || check.errors.length) throw new Error(check.errors.join('；') || '阶段验收失败')
        this.store.runInTransaction(() => {
          // 异步分析期间资料和确认状态可能变化，发布前须再次检查。
          if (this.project(projectId).input_revision !== run.input_revision) throw new Error('输入版本在执行期间发生变化')
          if (this.store.prepareInternal("SELECT id FROM issues WHERE workflow_run_id = ? AND severity = 'blocking' AND status = 'open' LIMIT 1").get(runId)) throw new Error('存在未处理阻断问题')
          const published = handler.publish(context, output)
          if (!published || Object.keys(published).length === 0) throw new Error('阶段发布结果不能为空')
          // 编排器只检查成果登记门槛，实际文件生成和内容校验仍由交付处理器负责。
          if (stage === 'deliver' && !this.store.prepareInternal("SELECT id FROM artifacts WHERE stage_run_id = ? AND status = 'ready' LIMIT 1").get(stageRunId!)) throw new Error('交付阶段没有已登记成果')
          this.store.prepareInternal("UPDATE stage_runs SET status = 'succeeded', output_manifest_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(published), Date.now(), stageRunId!)
          this.event(projectId, runId, stageRunId, 'stage.succeeded', { stage })
          upstream[stage] = published
        })
      }
      // 只有全部阶段都已发布成功，运行才进入 succeeded。
      this.store.runInTransaction(() => {
        this.store.prepareInternal("UPDATE workflow_runs SET status = 'succeeded', updated_at = ? WHERE id = ?").run(Date.now(), runId)
        this.event(projectId, runId, null, 'run.succeeded', {})
      })
    } catch (error) {
      // 仅更新仍在执行或验收的尝试，保留此前已成功阶段供后续显式重试复用。
      const status = controller.signal.aborted ? 'cancelled' : 'failed'
      this.store.runInTransaction(() => {
        if (stageRunId) this.store.prepareInternal("UPDATE stage_runs SET status = ?, error_json = ?, updated_at = ? WHERE id = ? AND status IN ('running','validating')").run(status, JSON.stringify({ message: error instanceof Error ? error.message : String(error) }), Date.now(), stageRunId)
        this.store.prepareInternal('UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), runId)
        this.event(projectId, runId, stageRunId, `run.${status}`, {})
      })
      throw error
    } finally {
      // 释放内存执行句柄；进程崩溃时的持久化中断恢复由 AppStore 启动逻辑处理。
      this.active.delete(runId)
    }
  }

  // 活动任务通过协作式取消收尾；没有本实例执行句柄时直接更新可取消记录。
  cancel(projectId: string, runId: string): void {
    const run = this.run(projectId, runId)
    if (!['pending', 'running', 'waiting_user'].includes(run.status)) throw new Error('当前运行不可取消')
    const controller = this.active.get(runId)
    // abort 发出请求而非强杀进程，最终状态由 execute 的异常收尾写入。
    if (controller) { controller.abort(new Error('用户取消')); return }
    this.store.runInTransaction(() => {
      this.store.prepareInternal("UPDATE stage_runs SET status = 'cancelled', updated_at = ? WHERE workflow_run_id = ? AND status IN ('pending','running','validating','waiting_user')").run(Date.now(), runId)
      this.store.prepareInternal("UPDATE workflow_runs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), runId)
      this.event(projectId, runId, null, 'run.cancelled', {})
    })
  }

  // 事件随调用方事务持久化；这里只记账，尚不负责 IPC 推送或断线事件补取。
  private event(projectId: string, runId: string, stageId: string | null, type: string, payload: unknown): void {
    this.store.prepareInternal('INSERT INTO workflow_events(project_id, workflow_run_id, stage_run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, runId, stageId, type, JSON.stringify(payload), Date.now())
  }
}
