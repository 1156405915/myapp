import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  StandardValidationIssue,
  StandardValidationReport,
  ValidateStandardReferencesInput
} from '../../shared/knowledge-types'
import { validateWorkspacePath, validateWorkspaceRoot } from '../security/workspace-guard'
import type { AppStore } from '../store/app-store'
import { MethodCardRepository } from './method-card-repository'
import { normalizeIsoDate, normalizeStandardCode } from './standard-code'
import { StandardRepository } from './standard-repository'

const VALIDATION_DIRECTORY = '.mayi/knowledge/construction'

/** 对项目标准快照中的结构化引用执行确定性有效性检查。 */
export class StandardValidationService {
  private readonly methods: MethodCardRepository
  private readonly standards: StandardRepository

  constructor(private readonly store: AppStore) {
    this.methods = new MethodCardRepository(store)
    this.standards = new StandardRepository(store)
  }

  validateReferences(input: ValidateStandardReferencesInput): StandardValidationReport {
    const startedAt = Date.now()
    const session = this.store.getSession(input.sessionId)
    if (!session) throw new Error('会话不存在')
    const workspaceValidation = validateWorkspaceRoot(session.cwd)
    if (!workspaceValidation.allowed) throw new Error(workspaceValidation.reason || '项目工作区无效')
    const applicableDate = normalizeIsoDate(input.applicableDate, '引用适用日期')
    if (!['draft', 'formal'].includes(input.mode)) throw new Error('引用校验模式无效')
    if (!Array.isArray(input.references) || input.references.length === 0 || input.references.length > 500) {
      throw new Error('标准引用列表无效')
    }
    const snapshot = this.findLatestStandardSnapshot(session.id)
    const snapshotByCode = new Map(
      (snapshot?.standards || []).map((standard) => [normalizeStandardCode(standard.code), standard])
    )
    const issues: StandardValidationIssue[] = []

    input.references.forEach((reference, index) => {
      if (!reference.sourceId?.trim() || reference.sourceId.length > 200) {
        throw new Error('标准引用来源标识无效')
      }
      if (reference.sourceLocation && reference.sourceLocation.length > 500) {
        throw new Error('标准引用位置过长')
      }
      let normalizedCode: string
      try {
        normalizedCode = normalizeStandardCode(reference.rawCode)
      } catch {
        issues.push(issue(
          'invalid_standard_code',
          input.mode === 'formal' ? 'blocking' : 'high',
          index,
          `无法识别标准编号：${reference.rawCode}`,
          '核对原文编号并使用完整标准编号。'
        ))
        return
      }
      const snapshotItem = snapshotByCode.get(normalizedCode)
      if (!snapshotItem) {
        issues.push(issue(
          'standard_not_in_snapshot',
          input.mode === 'formal' ? 'blocking' : 'high',
          index,
          `标准 ${reference.rawCode} 不在当前项目标准快照中。`,
          '查询并核验该标准后创建新的项目标准快照。'
        ))
        return
      }
      const version = this.standards.getVersion(snapshotItem.versionId)
      if (!version) {
        issues.push(issue(
          'standard_version_missing',
          'blocking',
          index,
          `标准 ${reference.rawCode} 的固定版本记录不存在。`,
          '恢复标准版本记录并重新生成项目快照。'
        ))
        return
      }
      if (
        ['abolished', 'rejected'].includes(version.verificationStatus) ||
        ['abolished'].includes(version.status)
      ) {
        issues.push(issue(
          'standard_not_effective',
          'blocking',
          index,
          `标准 ${reference.rawCode} 已废止或被拒绝。`,
          '查明替代标准并执行项目增量复核。'
        ))
      } else if (['superseded', 'revised'].includes(version.status)) {
        issues.push(issue(
          'standard_superseded',
          'high',
          index,
          `标准 ${reference.rawCode} 已修订或被替代。`,
          '核对项目适用日期和替代关系。'
        ))
      }
      if (version.effectiveDate && version.effectiveDate > applicableDate) {
        issues.push(issue(
          'standard_not_yet_effective',
          'blocking',
          index,
          `标准 ${reference.rawCode} 在项目适用日期尚未实施。`,
          '改用适用日期当时有效的版本。'
        ))
      }
      if (version.abolishedDate && applicableDate >= version.abolishedDate) {
        issues.push(issue(
          'standard_abolished_by_date',
          'blocking',
          index,
          `标准 ${reference.rawCode} 在项目适用日期已经废止。`,
          '改用项目适用日期的现行版本。'
        ))
      }
      if (input.mode === 'formal' && !['verified_official', 'approved'].includes(version.verificationStatus)) {
        issues.push(issue(
          'standard_unverified',
          'blocking',
          index,
          `标准 ${reference.rawCode} 尚未完成正式核验。`,
          '完成官方来源核验和人工审核。'
        ))
      }
      if (reference.rawTitle?.trim() && normalizeTitle(reference.rawTitle) !== normalizeTitle(version.title)) {
        issues.push(issue(
          'standard_title_mismatch',
          'medium',
          index,
          `标准 ${reference.rawCode} 的名称与登记库不一致。`,
          `核对并统一为“${version.title}”。`
        ))
      }
      if (reference.clauseRef?.trim()) {
        const clauseExists = this.methods.hasApprovedClause(version.id, reference.clauseRef.trim())
        if (clauseExists === false) {
          issues.push(issue(
            'clause_not_found',
            'high',
            index,
            `未找到已审核条款 ${reference.clauseRef}。`,
            '核对条款号或补充合法全文条款数据。'
          ))
        } else if (clauseExists === undefined) {
          issues.push(issue(
            'clause_unverified',
            'medium',
            index,
            `当前只有标准元数据，无法验证条款 ${reference.clauseRef}。`,
            '取得合法全文并完成条款切分审核后复核。'
          ))
        }
      }
    })

    if (input.mode === 'formal' && !snapshot) {
      issues.unshift(issue(
        'formal_snapshot_missing',
        'blocking',
        0,
        '当前项目没有正式标准快照。',
        '完成标准查询、审核并创建正式快照。'
      ))
    } else if (input.mode === 'formal' && snapshot?.mode !== 'formal') {
      issues.unshift(issue(
        'formal_snapshot_required',
        'blocking',
        0,
        '当前项目最近的标准快照不是正式快照。',
        '创建只包含已核验版本的正式标准快照。'
      ))
    }

    const status = issues.some((item) => item.severity === 'blocking')
      ? 'blocked'
      : issues.length
        ? 'warnings'
        : 'passed'
    const generatedAt = Date.now()
    const inputHash = hashJson({
      applicableDate,
      mode: input.mode,
      references: input.references,
      snapshotHash: snapshot?.snapshotHash
    })
    const revision = this.nextValidationRevision(session.id)
    const artifactRelativePath = `${VALIDATION_DIRECTORY}/standards-validation-r${revision}.json`
    const report: StandardValidationReport = {
      schemaVersion: 1,
      runId: randomUUID(),
      projectId: session.id,
      standardSnapshotId: snapshot?.snapshotId,
      applicableDate,
      mode: input.mode,
      status,
      referencesChecked: input.references.length,
      issues,
      generatedAt,
      inputHash,
      artifactRelativePath
    }
    this.writeReport(session.cwd, report)
    this.methods.saveValidationReport(report, snapshot?.snapshotId)
    this.methods.recordRetrievalEvent({
      projectId: session.id,
      sessionId: session.id,
      queryType: 'reference_validation',
      queryHash: inputHash,
      filters: { mode: input.mode, applicableDate },
      candidateIds: input.references.map((reference) => reference.rawCode),
      selectedIds: snapshot?.standards.map((standard) => standard.versionId),
      latencyMs: Date.now() - startedAt
    })
    return report
  }

  listProjectImpacts(sessionId: string) {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    return this.methods.listProjectImpacts(session.id)
  }

  private findLatestStandardSnapshot(sessionId: string) {
    const row = this.store
      .prepareInternal(`
        SELECT snapshot_json FROM project_standard_snapshots
        WHERE session_id = ? ORDER BY revision DESC LIMIT 1
      `)
      .get(sessionId) as { snapshot_json: string } | undefined
    return row ? (JSON.parse(row.snapshot_json) as import('../../shared/knowledge-types').ProjectStandardSnapshot) : undefined
  }

  private nextValidationRevision(projectId: string): number {
    const row = this.store
      .prepareInternal(
        'SELECT COUNT(*) AS count FROM standard_validation_runs WHERE project_id = ?'
      )
      .get(projectId) as { count: number }
    return Number(row.count) + 1
  }

  private writeReport(workspace: string, report: StandardValidationReport): void {
    const target = resolve(workspace, report.artifactRelativePath)
    const validation = validateWorkspacePath(workspace, target, true)
    if (!validation.allowed) throw new Error(validation.reason || '标准校验报告路径无效')
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    try {
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
}

function issue(
  ruleCode: string,
  severity: StandardValidationIssue['severity'],
  referenceIndex: number,
  message: string,
  suggestion: string
): StandardValidationIssue {
  return { ruleCode, severity, status: 'open', referenceIndex, message, suggestion }
}

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').replace(/[\s《》<>]/g, '').toLowerCase()
}

function hashJson(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
