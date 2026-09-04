import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  CreateProjectMethodSnapshotInput,
  MethodCardInput,
  MethodCardVersion,
  MethodDiscipline,
  MethodMatchInput,
  MethodMatchResult,
  MethodSourceKind,
  ProjectMethodSnapshot
} from '../../shared/knowledge-types'
import { validateWorkspacePath, validateWorkspaceRoot } from '../security/workspace-guard'
import type { AppStore } from '../store/app-store'
import { MethodCardRepository } from './method-card-repository'
import { normalizeStandardCode, normalizeStringList } from './standard-code'

const DISCIPLINES = new Set<MethodDiscipline>([
  'road',
  'drainage',
  'utility',
  'traffic',
  'lighting',
  'landscape',
  'common'
])
const REVIEW_STATUSES = new Set(['draft', 'reviewed', 'approved', 'retired', 'rejected'])
const SOURCE_KINDS = new Set<MethodSourceKind>(['builtin', 'enterprise', 'project'])
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const METHOD_SNAPSHOT_DIRECTORY = '.mayi/knowledge/construction'

/** 提供内置工法卡加载、确定性匹配和项目工法版本冻结。 */
export class MethodCardService {
  private readonly repository: MethodCardRepository

  constructor(private readonly store: AppStore) {
    this.repository = new MethodCardRepository(store)
  }

  loadBuiltinCards(cardsRoot: string): MethodCardVersion[] {
    const root = resolve(cardsRoot)
    const files = this.collectJsonFiles(root)
    return files.map((file) => {
      const bytes = readFileSync(file)
      if (bytes.length > 512 * 1024) throw new Error(`内置工法卡过大：${file}`)
      return this.importMethodCard(JSON.parse(bytes.toString('utf8')) as MethodCardInput, 'builtin')
    })
  }

  importMethodCard(input: MethodCardInput, sourceKind: MethodSourceKind): MethodCardVersion {
    if (!SOURCE_KINDS.has(sourceKind)) throw new Error('工法卡来源类型无效')
    const card = this.validateCard(input)
    return this.repository.upsertMethodCard(card, hashJson(card), sourceKind, Date.now())
  }

  matchMethodCards(input: MethodMatchInput): MethodMatchResult {
    const startedAt = Date.now()
    const session = this.store.getSession(input.sessionId)
    if (!session) throw new Error('会话不存在')
    if (!Array.isArray(input.disciplines) || input.disciplines.length === 0) {
      throw new Error('工法专业范围无效')
    }
    const disciplines = [...new Set(input.disciplines)]
    if (disciplines.some((discipline) => !DISCIPLINES.has(discipline))) {
      throw new Error('工法专业范围无效')
    }
    const factIds = normalizeStringList(input.factIds, '项目事实标识')
    if (!['draft', 'formal'].includes(input.mode)) throw new Error('工法匹配模式无效')
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('工法候选数量无效')
    const factSet = new Set(factIds)
    const candidates = this.repository
      .listMethodVersions(disciplines)
      .map((method) => {
        const matchedFactIds = method.applicableFactIds.filter((id) => factSet.has(id))
        const pendingFactIds = method.requiredFactIds.filter((id) => !factSet.has(id))
        const excludedByFactIds = method.excludedFactIds.filter((id) => factSet.has(id))
        const warnings: string[] = []
        if (pendingFactIds.length) warnings.push('缺少正式采用该工法所需的项目事实。')
        if (method.controlPoints.some((point) => point.sourceType === 'assumption')) {
          warnings.push('工法卡包含假设来源控制参数。')
        }
        if (!['reviewed', 'approved'].includes(method.reviewStatus)) {
          warnings.push('工法卡尚未通过审核。')
        }
        const applicability = excludedByFactIds.length
          ? 'not_applicable'
          : pendingFactIds.length ||
              (method.applicableFactIds.length > 0 && matchedFactIds.length === 0)
            ? 'conditional'
            : 'applicable'
        return {
          method,
          applicability,
          matchedFactIds,
          pendingFactIds,
          excludedByFactIds,
          warnings
        } as const
      })
      .filter((candidate) => candidate.applicability !== 'not_applicable')
      .filter((candidate) => input.mode !== 'formal' || candidate.method.reviewStatus === 'approved')
      .sort((left, right) => {
        const rank = { applicable: 0, conditional: 1, not_applicable: 2 }
        return rank[left.applicability] - rank[right.applicability] ||
          right.matchedFactIds.length - left.matchedFactIds.length ||
          left.method.name.localeCompare(right.method.name)
      })
      .slice(0, limit)
    const factsHash = hashJson(factIds)
    this.repository.recordRetrievalEvent({
      projectId: session.id,
      sessionId: session.id,
      queryType: 'method',
      queryHash: hashJson({ disciplines, factsHash, mode: input.mode }),
      filters: { disciplines, mode: input.mode },
      candidateIds: candidates.map((candidate) => candidate.method.versionId),
      latencyMs: Date.now() - startedAt
    })
    return { factsHash, candidates, generatedAt: Date.now() }
  }

  createProjectMethodSnapshot(input: CreateProjectMethodSnapshotInput): ProjectMethodSnapshot {
    const session = this.store.getSession(input.sessionId)
    if (!session) throw new Error('会话不存在')
    const workspaceValidation = validateWorkspaceRoot(session.cwd)
    if (!workspaceValidation.allowed) throw new Error(workspaceValidation.reason || '项目工作区无效')
    if (!HASH_PATTERN.test(input.factsHash)) throw new Error('项目事实哈希无效')
    if (!['draft', 'formal'].includes(input.mode)) throw new Error('工法快照模式无效')
    if (!Array.isArray(input.methods) || input.methods.length === 0 || input.methods.length > 100) {
      throw new Error('工法快照列表无效')
    }
    const standardSnapshot = input.standardSnapshotId
      ? this.repository.getStandardSnapshot(input.standardSnapshotId)
      : undefined
    if (input.standardSnapshotId && !standardSnapshot) throw new Error('项目标准快照不存在')
    if (input.mode === 'formal' && (!standardSnapshot || standardSnapshot.mode !== 'formal')) {
      throw new Error('正式工法快照必须绑定正式标准快照')
    }
    const standardCodes = new Set(
      (standardSnapshot?.standards || []).map((standard) => normalizeStandardCode(standard.code))
    )
    const seen = new Set<string>()
    const methods = input.methods.map((selection) => {
      if (!['entity', 'risk', 'tender', 'design', 'user'].includes(selection.selectionReason)) {
        throw new Error('工法选择原因无效')
      }
      if (seen.has(selection.methodVersionId)) throw new Error('工法快照包含重复版本')
      seen.add(selection.methodVersionId)
      const method = this.repository.getMethodVersion(selection.methodVersionId)
      if (!method) throw new Error('工法卡版本不存在')
      if (['retired', 'rejected'].includes(method.reviewStatus)) {
        throw new Error(`工法卡不可用：${method.name}`)
      }
      if (input.mode === 'formal' && method.reviewStatus !== 'approved') {
        throw new Error(`正式快照不能使用未批准工法卡：${method.name}`)
      }
      if (
        input.mode === 'formal' &&
        method.controlPoints.some((point) => point.required && point.sourceType === 'assumption')
      ) {
        throw new Error(`正式快照不能使用假设控制参数：${method.name}`)
      }
      const requiredCodes = method.sourceRefs
        .filter((ref) => ref.required)
        .map((ref) => normalizeStandardCode(ref.code))
      const missingCodes = requiredCodes.filter((code) => !standardCodes.has(code))
      if (input.mode === 'formal' && missingCodes.length) {
        throw new Error(`正式标准快照缺少工法依据：${method.name}`)
      }
      return {
        id: method.id,
        name: method.name,
        versionId: method.versionId,
        contentHash: method.contentHash,
        selectionReason: selection.selectionReason,
        reviewStatus: method.reviewStatus,
        standardCodes: method.sourceRefs.map((ref) => ref.code)
      }
    })
    methods.sort((left, right) => left.id.localeCompare(right.id))

    const revision = this.repository.nextMethodSnapshotRevision(session.id)
    const artifactRelativePath = `${METHOD_SNAPSHOT_DIRECTORY}/project-method-snapshot-r${revision}.json`
    const base = {
      schemaVersion: 1 as const,
      snapshotId: randomUUID(),
      projectId: session.id,
      sessionId: session.id,
      factsHash: input.factsHash,
      standardSnapshotId: input.standardSnapshotId,
      mode: input.mode,
      revision,
      methods,
      generatedAt: Date.now(),
      artifactRelativePath
    }
    const snapshot: ProjectMethodSnapshot = { ...base, snapshotHash: hashJson(base) }
    this.writeSnapshot(session.cwd, artifactRelativePath, snapshot, () => {
      this.repository.saveMethodSnapshot(snapshot)
    }, () => {
      this.repository.setMethodSnapshotArtifactState(snapshot.snapshotId, 'ready')
    }, () => {
      this.repository.setMethodSnapshotArtifactState(snapshot.snapshotId, 'missing')
    })
    return snapshot
  }

  getLatestProjectMethodSnapshot(sessionId: string): ProjectMethodSnapshot | undefined {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    return this.repository.getLatestMethodSnapshot(session.id)
  }

  private validateCard(input: MethodCardInput): MethodCardInput {
    if (!input || typeof input !== 'object' || input.schemaVersion !== 1) {
      throw new Error('工法卡格式无效')
    }
    if (!ID_PATTERN.test(input.id) || !VERSION_PATTERN.test(input.version)) {
      throw new Error('工法卡标识或版本无效')
    }
    if (!input.name?.trim() || input.name.length > 200 || !DISCIPLINES.has(input.discipline)) {
      throw new Error('工法卡名称或专业无效')
    }
    if (!REVIEW_STATUSES.has(input.reviewStatus)) throw new Error('工法卡审核状态无效')
    if (!Array.isArray(input.workflow) || input.workflow.length === 0 || input.workflow.length > 100) {
      throw new Error('工法卡施工流程无效')
    }
    if (!Array.isArray(input.controlPoints) || input.controlPoints.length > 100) {
      throw new Error('工法卡控制点无效')
    }
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 50) {
      throw new Error('工法卡标准依据无效')
    }
    return {
      ...input,
      name: input.name.trim(),
      tags: normalizeOptionalList(input.tags, '工法标签'),
      applicableFactIds: normalizeOptionalList(input.applicableFactIds, '适用事实'),
      excludedFactIds: normalizeOptionalList(input.excludedFactIds, '排除事实'),
      requiredFactIds: normalizeOptionalList(input.requiredFactIds, '必要事实'),
      laborRoles: normalizeOptionalList(input.laborRoles, '人员岗位'),
      equipmentTypes: normalizeOptionalList(input.equipmentTypes, '机械类型'),
      qualityEvidence: normalizeOptionalList(input.qualityEvidence, '质量证据'),
      safetyRisks: normalizeOptionalList(input.safetyRisks, '安全风险'),
      environmentalControls: normalizeOptionalList(input.environmentalControls, '环境措施'),
      prohibitedAssumptions: normalizeOptionalList(input.prohibitedAssumptions, '禁止假设')
    }
  }

  private collectJsonFiles(root: string): string[] {
    const files: string[] = []
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (lstatSync(path).isSymbolicLink()) throw new Error(`内置工法卡不能使用符号链接：${path}`)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
      }
    }
    walk(root)
    return files.sort()
  }

  private writeSnapshot(
    workspace: string,
    relativePath: string,
    value: object,
    persistPending: () => void,
    markReady: () => void,
    markMissing: () => void
  ): void {
    const target = resolve(workspace, relativePath)
    const validation = validateWorkspacePath(workspace, target, true)
    if (!validation.allowed) throw new Error(validation.reason || '工法快照路径无效')
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    try {
      persistPending()
      renameSync(temporary, target)
      markReady()
    } catch (error) {
      rmSync(temporary, { force: true })
      try {
        markMissing()
      } catch {
        // 原始错误优先返回，残留 pending 记录可由后续恢复流程处理。
      }
      throw error
    }
  }
}

function normalizeOptionalList(values: string[], fieldName: string): string[] {
  if (!Array.isArray(values) || values.length > 50) throw new Error(`${fieldName}无效`)
  if (values.length === 0) return []
  return normalizeStringList(values, fieldName)
}

function hashJson(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
