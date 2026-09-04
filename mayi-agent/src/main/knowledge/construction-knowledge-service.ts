import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  CreateProjectMethodSnapshotInput,
  CreateProjectStandardSnapshotInput,
  ManualStandardImport,
  MethodMatchInput,
  OfficialSyncRun,
  OfficialSyncScope,
  ProjectStandardSnapshot,
  StandardQueryInput,
  StandardQueryResult,
  StandardVerificationStatus,
  ValidateStandardReferencesInput
} from '../../shared/knowledge-types'
import { validateWorkspacePath, validateWorkspaceRoot } from '../security/workspace-guard'
import type { AppStore } from '../store/app-store'
import { normalizeIsoDate, normalizeStandardCode, normalizeStringList } from './standard-code'
import { MethodCardRepository } from './method-card-repository'
import { MethodCardService } from './method-card-service'
import { StandardValidationService } from './standard-validation-service'
import { StandardRepository } from './standard-repository'

const DAY_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_DIRECTORY = '.mayi/knowledge/construction'
const FORMAL_STATUSES = new Set<StandardVerificationStatus>(['verified_official', 'approved'])
const SOURCE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  'national-standard-platform': ['std.samr.gov.cn', 'openstd.samr.gov.cn'],
  'housing-ministry': ['www.mohurd.gov.cn', 'mohurd.gov.cn'],
  'anhui-housing': ['dohurd.ah.gov.cn'],
  'hefei-housing': ['cxjsj.hefei.gov.cn']
}

const LEVELS = new Set(['national', 'industry', 'anhui', 'hefei', 'group', 'enterprise'])
const STATUSES = new Set(['active', 'revised', 'superseded', 'abolished', 'unknown'])
const MANDATORY_NATURES = new Set(['mandatory', 'recommended', 'partially-mandatory', 'unknown'])
const FULL_TEXT_ACCESS = new Set(['public', 'licensed', 'metadata-only'])
const REVIEW_STATUSES = new Set<StandardVerificationStatus>([
  'pending_review',
  'verified_official',
  'approved',
  'superseded',
  'abolished',
  'rejected'
])

export interface OfficialStandardProvider {
  id: string
  supports(input: StandardQueryInput): boolean
  lookup(input: StandardQueryInput, signal: AbortSignal): Promise<ManualStandardImport | undefined>
  sync?(scope: OfficialSyncScope, signal: AbortSignal): Promise<OfficialProviderRecord[]>
}

export interface OfficialProviderRecord {
  externalId: string
  requestedUrl: string
  finalUrl: string
  contentType: string
  contentLength: number
  responseHash: string
  fetchedAt: number
  metadata: ManualStandardImport
}

export interface KnowledgeCachePolicy {
  verifiedTtlMs: number
  negativeTtlMs: number
  requestTimeoutMs: number
}

const DEFAULT_CACHE_POLICY: KnowledgeCachePolicy = {
  verifiedTtlMs: 30 * DAY_MS,
  negativeTtlMs: DAY_MS,
  requestTimeoutMs: 15_000
}

const REVIEW_TRANSITIONS: Readonly<Record<StandardVerificationStatus, readonly StandardVerificationStatus[]>> = {
  discovered: ['pending_review', 'rejected'],
  pending_review: ['verified_official', 'rejected'],
  verified_official: ['approved', 'superseded', 'abolished'],
  approved: ['superseded', 'abolished'],
  superseded: ['abolished'],
  abolished: [],
  rejected: []
}

/** 主进程标准知识服务：负责校验、Cache-Aside、审核状态和不可变项目快照。 */
export class ConstructionKnowledgeService {
  private readonly repository: StandardRepository
  private readonly impacts: MethodCardRepository
  private readonly methodCards: MethodCardService
  private readonly validation: StandardValidationService
  private readonly queryLocks = new Map<string, Promise<StandardQueryResult>>()

  constructor(
    private readonly store: AppStore,
    private readonly providers: OfficialStandardProvider[] = [],
    private readonly cachePolicy: KnowledgeCachePolicy = DEFAULT_CACHE_POLICY
  ) {
    this.repository = new StandardRepository(store)
    this.impacts = new MethodCardRepository(store)
    this.methodCards = new MethodCardService(store)
    this.validation = new StandardValidationService(store)
  }

  importStandard(input: ManualStandardImport): ReturnType<StandardRepository['upsertImportedStandard']> {
    const normalized = this.validateImport(input)
    const sourceHash = hashJson(normalized)
    return this.repository.upsertImportedStandard(normalized, sourceHash, Date.now())
  }

  reviewStandard(
    versionId: string,
    status: StandardVerificationStatus,
    reason = '用户审核标准状态'
  ) {
    if (typeof versionId !== 'string' || !versionId.trim()) throw new Error('标准版本 ID 无效')
    if (!REVIEW_STATUSES.has(status)) throw new Error('标准审核状态无效')
    if (!reason.trim() || reason.length > 500) throw new Error('标准审核原因无效')
    const previous = this.repository.getVersion(versionId.trim())
    if (!previous) throw new Error('标准版本不存在')
    if (!REVIEW_TRANSITIONS[previous.verificationStatus].includes(status)) {
      throw new Error(`不允许从 ${previous.verificationStatus} 转换为 ${status}`)
    }
    const version = this.repository.setVerificationStatus(versionId.trim(), status)
    this.repository.appendReview({
      entityType: 'standard_version',
      entityId: version.id,
      previousStatus: previous.verificationStatus,
      decision: status,
      reviewerType: 'user',
      reason: reason.trim()
    })
    if (['superseded', 'abolished', 'rejected'].includes(status)) {
      this.impacts.createImpactsForStandard(version.id, `标准核验状态变更为 ${status}`)
    }
    return version
  }

  loadBuiltinMethodCards(cardsRoot: string) {
    return this.methodCards.loadBuiltinCards(cardsRoot)
  }

  matchMethodCards(input: MethodMatchInput) {
    return this.methodCards.matchMethodCards(input)
  }

  createProjectMethodSnapshot(input: CreateProjectMethodSnapshotInput) {
    return this.methodCards.createProjectMethodSnapshot(input)
  }

  getLatestProjectMethodSnapshot(sessionId: string) {
    return this.methodCards.getLatestProjectMethodSnapshot(sessionId)
  }

  validateStandardReferences(input: ValidateStandardReferencesInput) {
    return this.validation.validateReferences(input)
  }

  listProjectKnowledgeImpacts(sessionId: string) {
    return this.validation.listProjectImpacts(sessionId)
  }

  async syncOfficialMetadata(providerId: string, scope: OfficialSyncScope): Promise<OfficialSyncRun> {
    const provider = this.providers.find((candidate) => candidate.id === providerId && candidate.sync)
    if (!provider?.sync) throw new Error('官方来源适配器不支持增量同步')
    const normalizedScope: OfficialSyncScope = {
      codes: normalizeStringList(scope.codes, '同步标准编号').map(normalizeStandardCode),
      jurisdiction: scope.jurisdiction.trim(),
      discipline: scope.discipline?.trim() || undefined,
      applicableDate: normalizeIsoDate(scope.applicableDate, '同步适用日期')
    }
    if (!normalizedScope.jurisdiction || normalizedScope.jurisdiction.length > 100) {
      throw new Error('同步地区无效')
    }
    const startedAt = Date.now()
    const runId = this.repository.startOfficialSync(provider.id, normalizedScope, startedAt)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.cachePolicy.requestTimeoutMs)
    let discovered = 0
    let notFound = 0
    let failed = 0
    let errorSummary: string | undefined
    try {
      const records = await provider.sync(normalizedScope, controller.signal)
      if (!Array.isArray(records) || records.length > 200) throw new Error('官方同步结果数量无效')
      for (const record of records) {
        try {
          this.validateProviderRecord(provider.id, record)
          const metadata = this.validateImport(record.metadata)
          this.repository.saveOfficialSourceRecord({
            syncRunId: runId,
            providerId: provider.id,
            externalId: record.externalId,
            requestedUrl: record.requestedUrl,
            finalUrl: record.finalUrl,
            contentType: record.contentType,
            contentLength: record.contentLength,
            responseHash: record.responseHash,
            metadata,
            fetchedAt: record.fetchedAt
          })
          this.repository.upsertImportedStandard(metadata, record.responseHash, record.fetchedAt)
          discovered += 1
        } catch {
          failed += 1
        }
      }
      notFound = Math.max(0, normalizedScope.codes.length - discovered - failed)
    } catch (error) {
      failed = normalizedScope.codes.length
      errorSummary = controller.signal.aborted
        ? 'official_sync_timeout'
        : error instanceof Error
          ? error.message.slice(0, 200)
          : 'official_sync_failed'
    } finally {
      clearTimeout(timeout)
    }
    const status = failed === 0 ? 'succeeded' : discovered > 0 ? 'partial' : 'failed'
    const finishedAt = Date.now()
    this.repository.finishOfficialSync({
      runId,
      status,
      discovered,
      notFound,
      failed,
      finishedAt,
      errorSummary
    })
    return { id: runId, providerId, status, discovered, notFound, failed, startedAt, finishedAt }
  }

  async queryStandard(input: StandardQueryInput): Promise<StandardQueryResult> {
    const query = this.validateQuery(input)
    const queryKey = this.queryKey(query)
    const existing = this.queryLocks.get(queryKey)
    if (existing) return existing

    const operation = this.queryStandardUnlocked(query, queryKey).finally(() => {
      this.queryLocks.delete(queryKey)
    })
    this.queryLocks.set(queryKey, operation)
    return operation
  }

  getLatestProjectSnapshot(sessionId: string): ProjectStandardSnapshot | undefined {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('会话 ID 无效')
    return this.repository.getLatestSnapshot(sessionId.trim())
  }

  createProjectSnapshot(input: CreateProjectStandardSnapshotInput): ProjectStandardSnapshot {
    const session = this.store.getSession(input.sessionId)
    if (!session) throw new Error('会话不存在')
    const workspaceValidation = validateWorkspaceRoot(session.cwd)
    if (!workspaceValidation.allowed) throw new Error(workspaceValidation.reason || '项目工作区无效')
    const applicableDate = normalizeIsoDate(input.applicableDate, '项目适用日期')
    if (!['draft', 'formal'].includes(input.mode)) throw new Error('快照模式无效')
    if (!Array.isArray(input.standards) || input.standards.length === 0 || input.standards.length > 200) {
      throw new Error('快照标准列表无效')
    }

    const selectionKeys = new Set<string>()
    const standards = input.standards.map((selection) => {
      if (!['tender', 'design', 'mandatory', 'regional', 'method'].includes(selection.selectionReason)) {
        throw new Error('标准选择原因无效')
      }
      const key = `${selection.versionId}|${selection.selectionReason}`
      if (selectionKeys.has(key)) throw new Error('快照标准列表包含重复项')
      selectionKeys.add(key)
      const version = this.repository.getVersion(selection.versionId)
      if (!version) throw new Error('快照包含不存在的标准版本')
      if (input.mode === 'formal' && !FORMAL_STATUSES.has(version.verificationStatus)) {
        throw new Error(`正式快照不能使用未核验标准：${version.code}`)
      }
      if (['rejected', 'abolished'].includes(version.verificationStatus)) {
        throw new Error(`快照不能使用已拒绝或废止标准：${version.code}`)
      }
      if (version.effectiveDate && version.effectiveDate > applicableDate) {
        throw new Error(`标准在项目适用日期尚未实施：${version.code}`)
      }
      if (version.abolishedDate && applicableDate >= version.abolishedDate) {
        throw new Error(`标准在项目适用日期已经废止：${version.code}`)
      }
      return {
        code: version.code,
        title: version.title,
        versionId: version.id,
        sourceHash: version.sourceHash,
        selectionReason: selection.selectionReason,
        verificationStatus: version.verificationStatus,
        verifiedAt: version.checkedAt
      }
    })
    standards.sort((left, right) =>
      `${left.code}|${left.selectionReason}`.localeCompare(`${right.code}|${right.selectionReason}`)
    )

    const projectId = session.id
    const revision = this.repository.nextSnapshotRevision(projectId)
    const generatedAt = Date.now()
    const snapshotId = randomUUID()
    const artifactRelativePath = `${SNAPSHOT_DIRECTORY}/project-standard-snapshot-r${revision}.json`
    const base = {
      schemaVersion: 1 as const,
      snapshotId,
      projectId,
      sessionId: session.id,
      applicableDate,
      mode: input.mode,
      revision,
      standards,
      generatedAt,
      artifactRelativePath
    }
    const snapshot: ProjectStandardSnapshot = { ...base, snapshotHash: hashJson(base) }
    const artifactPath = resolve(session.cwd, artifactRelativePath)
    const pathValidation = validateWorkspacePath(session.cwd, artifactPath, true)
    if (!pathValidation.allowed) throw new Error(pathValidation.reason || '快照产物路径无效')
    mkdirSync(dirname(artifactPath), { recursive: true })
    const temporaryPath = `${artifactPath}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    })
    this.repository.saveSnapshot(snapshot, resolve(session.cwd), input.standards)
    try {
      renameSync(temporaryPath, artifactPath)
      this.repository.setSnapshotArtifactState(snapshot.snapshotId, 'ready')
    } catch (error) {
      rmSync(temporaryPath, { force: true })
      try {
        this.repository.setSnapshotArtifactState(snapshot.snapshotId, 'missing')
      } catch {
        // 保留原始发布错误，启动恢复流程可继续处理未完成记录。
      }
      throw error
    }
    return snapshot
  }

  private async queryStandardUnlocked(
    query: StandardQueryInput,
    queryKey: string
  ): Promise<StandardQueryResult> {
    const now = Date.now()
    const cachedQuery = this.repository.getCachedQuery(queryKey)
    if (cachedQuery?.result_status === 'not_found' && cachedQuery.expires_at > now) {
      return {
        normalizedCode: normalizeStandardCode(query.code),
        cacheState: 'negative_hit',
        usableForFormal: false,
        checkedAt: cachedQuery.queried_at,
        warnings: ['官方来源负缓存尚未过期，未重复查询。']
      }
    }

    const local = this.repository.findApplicableVersion(query)
    const isFresh = local && now - local.checkedAt <= this.cachePolicy.verifiedTtlMs
    if (local && isFresh) return this.resultForVersion(local, 'hit')

    const provider = this.providers.find((candidate) => candidate.supports(query))
    if (!provider) {
      if (local) return this.resultForVersion(local, 'stale', ['本地记录已过期，暂无匹配的官方来源适配器。'])
      this.repository.saveQuery({
        queryKey,
        query,
        sourceId: 'none',
        resultStatus: 'not_found',
        queriedAt: now,
        expiresAt: now + this.cachePolicy.negativeTtlMs,
        errorCode: 'no_provider'
      })
      return {
        normalizedCode: normalizeStandardCode(query.code),
        cacheState: 'miss',
        usableForFormal: false,
        checkedAt: now,
        warnings: ['本地标准库未命中，且暂无匹配的官方来源适配器。']
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.cachePolicy.requestTimeoutMs)
    try {
      const discovered = await provider.lookup(query, controller.signal)
      if (!discovered) {
        this.repository.saveQuery({
          queryKey,
          query,
          sourceId: provider.id,
          resultStatus: 'not_found',
          queriedAt: now,
          expiresAt: now + this.cachePolicy.negativeTtlMs
        })
        return local
          ? this.resultForVersion(local, 'stale', ['官方刷新未找到新记录，继续使用过期缓存。'])
          : {
              normalizedCode: normalizeStandardCode(query.code),
              cacheState: 'miss',
              usableForFormal: false,
              checkedAt: now,
              warnings: ['官方来源未找到匹配标准。']
            }
      }
      const version = this.importStandard(discovered)
      this.repository.saveQuery({
        queryKey,
        query,
        sourceId: provider.id,
        resultStatus: 'found',
        resolvedVersionId: version.id,
        responseHash: version.sourceHash,
        queriedAt: now,
        expiresAt: now + this.cachePolicy.verifiedTtlMs
      })
      return this.resultForVersion(version, local ? 'stale' : 'miss', [
        '新发现记录处于待审核状态，不能直接用于正式施组。'
      ])
    } catch {
      this.repository.saveQuery({
        queryKey,
        query,
        sourceId: provider.id,
        resultStatus: 'failed',
        queriedAt: now,
        expiresAt: now + this.cachePolicy.negativeTtlMs,
        errorCode: controller.signal.aborted ? 'timeout' : 'provider_failed'
      })
      if (local) return this.resultForVersion(local, 'refresh_failed', ['官方来源刷新失败，已返回本地过期缓存。'])
      return {
        normalizedCode: normalizeStandardCode(query.code),
        cacheState: 'refresh_failed',
        usableForFormal: false,
        checkedAt: now,
        warnings: ['官方来源查询失败，且没有可用本地缓存。']
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private resultForVersion(
    version: NonNullable<ReturnType<StandardRepository['findApplicableVersion']>>,
    cacheState: StandardQueryResult['cacheState'],
    warnings: string[] = []
  ): StandardQueryResult {
    const usableForFormal = FORMAL_STATUSES.has(version.verificationStatus)
    if (!usableForFormal) warnings = [...warnings, '该版本尚未通过正式核验。']
    return {
      normalizedCode: version.normalizedCode,
      cacheState,
      version,
      usableForFormal,
      checkedAt: version.checkedAt,
      warnings
    }
  }

  private validateQuery(input: StandardQueryInput): StandardQueryInput {
    if (!input || typeof input !== 'object') throw new Error('标准查询参数无效')
    const jurisdiction = input.jurisdiction?.trim()
    const discipline = input.discipline?.trim()
    if (!jurisdiction || jurisdiction.length > 100) throw new Error('查询地区无效')
    if (discipline && discipline.length > 100) throw new Error('查询专业无效')
    if (!['draft', 'formal'].includes(input.purpose)) throw new Error('查询用途无效')
    return {
      code: normalizeStandardCode(input.code),
      jurisdiction,
      discipline: discipline || undefined,
      applicableDate: normalizeIsoDate(input.applicableDate, '标准适用日期'),
      purpose: input.purpose
    }
  }

  private validateImport(input: ManualStandardImport): ManualStandardImport {
    if (!input || typeof input !== 'object') throw new Error('标准导入参数无效')
    const title = input.title?.trim()
    if (!title || title.length > 300) throw new Error('标准名称无效')
    if (!LEVELS.has(input.level)) throw new Error('标准层级无效')
    if (!STATUSES.has(input.status)) throw new Error('标准状态无效')
    if (!MANDATORY_NATURES.has(input.mandatoryNature)) throw new Error('强制属性无效')
    if (!FULL_TEXT_ACCESS.has(input.fullTextAccess)) throw new Error('全文访问属性无效')
    const officialSourceId = input.officialSourceId?.trim()
    if (!officialSourceId || officialSourceId.length > 100) throw new Error('官方来源标识无效')
    const officialSourceUrl = this.validateOfficialSourceUrl(officialSourceId, input.officialSourceUrl)
    const normalized: ManualStandardImport = {
      ...input,
      code: normalizeStandardCode(input.code),
      title,
      jurisdictions: normalizeStringList(input.jurisdictions, '适用地区'),
      disciplines: normalizeStringList(input.disciplines, '专业范围'),
      officialSourceId,
      officialSourceUrl,
      replaces: input.replaces
        ? normalizeStringList(input.replaces, '替代标准').map(normalizeStandardCode)
        : undefined,
      replacedBy: input.replacedBy
        ? normalizeStringList(input.replacedBy, '被替代标准').map(normalizeStandardCode)
        : undefined
    }
    if (input.publishDate) normalized.publishDate = normalizeIsoDate(input.publishDate, '发布日期')
    if (input.effectiveDate) normalized.effectiveDate = normalizeIsoDate(input.effectiveDate, '实施日期')
    if (input.abolishedDate) normalized.abolishedDate = normalizeIsoDate(input.abolishedDate, '废止日期')
    if (
      normalized.effectiveDate &&
      normalized.abolishedDate &&
      normalized.effectiveDate >= normalized.abolishedDate
    ) {
      throw new Error('废止日期必须晚于实施日期')
    }
    return normalized
  }

  private validateOfficialSourceUrl(sourceId: string, value: string): string {
    const allowedHosts = SOURCE_HOSTS[sourceId]
    if (!allowedHosts) throw new Error('官方来源不在应用白名单中')
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error('官方来源 URL 无效')
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !allowedHosts.includes(url.hostname.toLowerCase())
    ) {
      throw new Error('官方来源 URL 不符合白名单安全策略')
    }
    return url.toString()
  }

  private validateProviderRecord(providerId: string, record: OfficialProviderRecord): void {
    if (!record.externalId?.trim() || record.externalId.length > 200) {
      throw new Error('官方记录标识无效')
    }
    this.validateOfficialSourceUrl(providerId, record.requestedUrl)
    this.validateOfficialSourceUrl(providerId, record.finalUrl)
    if (!['application/json', 'text/html'].includes(record.contentType.split(';')[0].trim().toLowerCase())) {
      throw new Error('官方记录响应类型无效')
    }
    if (!Number.isInteger(record.contentLength) || record.contentLength < 0 || record.contentLength > 2 * 1024 * 1024) {
      throw new Error('官方记录响应大小无效')
    }
    if (!/^[0-9a-f]{64}$/.test(record.responseHash)) throw new Error('官方记录哈希无效')
    if (!Number.isInteger(record.fetchedAt) || record.fetchedAt <= 0 || record.fetchedAt > Date.now() + 60_000) {
      throw new Error('官方记录获取时间无效')
    }
  }

  private queryKey(input: StandardQueryInput): string {
    return [
      normalizeStandardCode(input.code),
      input.jurisdiction,
      input.discipline || '',
      input.applicableDate,
      input.purpose
    ].join('|')
  }
}

function hashJson(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
