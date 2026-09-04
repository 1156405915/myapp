import { randomUUID } from 'node:crypto'
import type {
  KnowledgeImpact,
  MethodCardInput,
  MethodCardVersion,
  MethodDiscipline,
  MethodSourceKind,
  ProjectMethodSnapshot,
  ProjectStandardSnapshot,
  StandardValidationReport
} from '../../shared/knowledge-types'
import type { AppStore } from '../store/app-store'
import { normalizeStandardCode } from './standard-code'

interface MethodVersionRow {
  version_id: string
  method_card_id: string
  version: string
  content_json: string
  content_hash: string
  review_status: MethodCardVersion['reviewStatus']
  source_kind: MethodSourceKind
  created_at: number
}

interface ImpactRow {
  id: string
  trigger_type: KnowledgeImpact['triggerType']
  trigger_entity_id: string
  target_type: KnowledgeImpact['targetType']
  target_id: string
  impact_type: KnowledgeImpact['impactType']
  severity: KnowledgeImpact['severity']
  reason: string
  status: KnowledgeImpact['status']
  detected_at: number
}

/** 持久化工法卡、工法快照、引用校验、影响记录和检索评估事件。 */
export class MethodCardRepository {
  constructor(private readonly store: AppStore) {}

  upsertMethodCard(
    card: MethodCardInput,
    contentHash: string,
    sourceKind: MethodSourceKind,
    now: number
  ): MethodCardVersion {
    return this.store.runInTransaction(() => {
      const existingCard = this.store
        .prepareInternal('SELECT id FROM method_cards WHERE id = ?')
        .get(card.id) as { id: string } | undefined
      if (!existingCard) {
        this.store
          .prepareInternal(`
            INSERT INTO method_cards(id, discipline, name, builtin, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?)
          `)
          .run(card.id, card.discipline, card.name, sourceKind === 'builtin' ? 1 : 0, now, now)
      } else {
        this.store
          .prepareInternal(
            'UPDATE method_cards SET discipline = ?, name = ?, updated_at = ? WHERE id = ?'
          )
          .run(card.discipline, card.name, now, card.id)
      }

      const existingVersion = this.store
        .prepareInternal(`
          SELECT id AS version_id FROM method_card_versions
          WHERE method_card_id = ? AND version = ? AND content_hash = ?
        `)
        .get(card.id, card.version, contentHash) as { version_id: string } | undefined
      const versionId = existingVersion?.version_id || randomUUID()
      if (!existingVersion) {
        this.store
          .prepareInternal(`
            INSERT INTO method_card_versions(
              id, method_card_id, schema_version, version, content_json, content_hash,
              review_status, source_kind, reviewed_at, created_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            versionId,
            card.id,
            card.schemaVersion,
            card.version,
            JSON.stringify(card),
            contentHash,
            card.reviewStatus,
            sourceKind,
            card.reviewedAt ?? null,
            now
          )
        this.saveMethodStandardRefs(versionId, card)
        this.store
          .prepareInternal(
            'INSERT INTO knowledge_reviews(id, entity_type, entity_id, previous_status, decision, reviewer_type, reason, evidence_refs_json, created_at) VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?)'
          )
          .run(
            randomUUID(),
            'method_version',
            versionId,
            card.reviewStatus,
            sourceKind === 'builtin' ? 'builtin_release' : 'user',
            sourceKind === 'builtin' ? '随内置技能资源发布' : '结构化工法卡导入',
            '[]',
            now
          )
      }
      if (card.reviewStatus === 'approved') {
        this.store
          .prepareInternal('UPDATE method_cards SET current_version_id = ? WHERE id = ?')
          .run(versionId, card.id)
      }
      const version = this.getMethodVersion(versionId)
      if (!version) throw new Error('工法卡版本写入失败')
      return version
    })
  }

  listMethodVersions(disciplines: MethodDiscipline[]): MethodCardVersion[] {
    if (disciplines.length === 0) return []
    const placeholders = disciplines.map(() => '?').join(', ')
    const rows = this.store
      .prepareInternal(`
        SELECT v.id AS version_id, v.method_card_id, v.version, v.content_json,
          v.content_hash, v.review_status, v.source_kind, v.created_at
        FROM method_card_versions v
        JOIN method_cards c ON c.id = v.method_card_id
        WHERE c.discipline IN (${placeholders})
        ORDER BY c.discipline, c.name, v.created_at DESC
      `)
      .all(...disciplines) as unknown as MethodVersionRow[]
    const seen = new Set<string>()
    return rows
      .filter((row) => {
        if (seen.has(row.method_card_id)) return false
        seen.add(row.method_card_id)
        return true
      })
      .map((row) => this.mapMethodVersion(row))
  }

  getMethodVersion(versionId: string): MethodCardVersion | undefined {
    const row = this.store
      .prepareInternal(`
        SELECT id AS version_id, method_card_id, version, content_json,
          content_hash, review_status, source_kind, created_at
        FROM method_card_versions WHERE id = ?
      `)
      .get(versionId) as MethodVersionRow | undefined
    return row ? this.mapMethodVersion(row) : undefined
  }

  getStandardSnapshot(snapshotId: string): ProjectStandardSnapshot | undefined {
    const row = this.store
      .prepareInternal('SELECT snapshot_json FROM project_standard_snapshots WHERE id = ?')
      .get(snapshotId) as { snapshot_json: string } | undefined
    return row ? (JSON.parse(row.snapshot_json) as ProjectStandardSnapshot) : undefined
  }

  nextMethodSnapshotRevision(projectId: string): number {
    const row = this.store
      .prepareInternal(
        'SELECT COALESCE(MAX(revision), 0) AS revision FROM project_method_snapshots WHERE project_id = ?'
      )
      .get(projectId) as { revision: number }
    return Number(row.revision) + 1
  }

  saveMethodSnapshot(snapshot: ProjectMethodSnapshot): void {
    this.store.runInTransaction(() => {
      this.store
        .prepareInternal(`
          INSERT INTO project_method_snapshots(
            id, project_id, created_by_session_id, revision, facts_hash,
            standard_snapshot_id, mode, snapshot_json, snapshot_hash,
            artifact_relative_path, artifact_state, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `)
        .run(
          snapshot.snapshotId,
          snapshot.projectId,
          snapshot.sessionId,
          snapshot.revision,
          snapshot.factsHash,
          snapshot.standardSnapshotId ?? null,
          snapshot.mode,
          JSON.stringify(snapshot),
          snapshot.snapshotHash,
          snapshot.artifactRelativePath,
          snapshot.generatedAt
        )
      const insert = this.store.prepareInternal(`
        INSERT INTO project_method_snapshot_items(snapshot_id, method_version_id, selection_reason)
        VALUES(?, ?, ?)
      `)
      for (const method of snapshot.methods) {
        insert.run(snapshot.snapshotId, method.versionId, method.selectionReason)
      }
    })
  }

  setMethodSnapshotArtifactState(
    snapshotId: string,
    state: 'ready' | 'missing' | 'hash_mismatch'
  ): void {
    this.store
      .prepareInternal('UPDATE project_method_snapshots SET artifact_state = ? WHERE id = ?')
      .run(state, snapshotId)
  }

  hasApprovedClause(standardVersionId: string, clauseRef: string): boolean | undefined {
    const documentCount = this.store
      .prepareInternal(
        "SELECT COUNT(*) AS count FROM standard_documents WHERE standard_version_id = ? AND parse_status = 'parsed'"
      )
      .get(standardVersionId) as { count: number }
    if (Number(documentCount.count) === 0) return undefined
    const row = this.store
      .prepareInternal(`
        SELECT 1 AS found FROM standard_clauses c
        JOIN standard_documents d ON d.id = c.document_id
        WHERE d.standard_version_id = ? AND c.clause_no = ? AND c.review_status = 'approved'
        LIMIT 1
      `)
      .get(standardVersionId, clauseRef) as { found: number } | undefined
    return Boolean(row)
  }

  getLatestMethodSnapshot(projectId: string): ProjectMethodSnapshot | undefined {
    const row = this.store
      .prepareInternal(`
        SELECT snapshot_json FROM project_method_snapshots
        WHERE project_id = ? AND artifact_state = 'ready'
        ORDER BY revision DESC LIMIT 1
      `)
      .get(projectId) as { snapshot_json: string } | undefined
    return row ? (JSON.parse(row.snapshot_json) as ProjectMethodSnapshot) : undefined
  }

  saveValidationReport(report: StandardValidationReport, snapshotId?: string): void {
    this.store.runInTransaction(() => {
      this.store
        .prepareInternal(`
          INSERT INTO standard_validation_runs(
            id, project_id, session_id, input_hash, standard_snapshot_id,
            status, report_json, artifact_relative_path, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          report.runId,
          report.projectId,
          report.projectId,
          report.inputHash,
          snapshotId ?? null,
          report.status,
          JSON.stringify(report),
          report.artifactRelativePath,
          report.generatedAt
        )
      const insert = this.store.prepareInternal(`
        INSERT INTO standard_validation_issues(
          id, run_id, rule_code, severity, status, reference_index, message, suggestion
        ) VALUES(?, ?, ?, ?, 'open', ?, ?, ?)
      `)
      for (const issue of report.issues) {
        insert.run(
          randomUUID(),
          report.runId,
          issue.ruleCode,
          issue.severity,
          issue.referenceIndex,
          issue.message,
          issue.suggestion
        )
      }
    })
  }

  recordRetrievalEvent(input: {
    projectId?: string
    sessionId?: string
    queryType: 'standard' | 'method' | 'reference_validation'
    queryHash: string
    filters: object
    candidateIds: string[]
    selectedIds?: string[]
    latencyMs: number
  }): void {
    this.store
      .prepareInternal(`
        INSERT INTO knowledge_retrieval_events(
          id, project_id, session_id, query_type, query_hash, filters_json,
          candidate_ids_json, selected_ids_json, zero_result, latency_ms, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.projectId ?? null,
        input.sessionId ?? null,
        input.queryType,
        input.queryHash,
        JSON.stringify(input.filters),
        JSON.stringify(input.candidateIds),
        JSON.stringify(input.selectedIds || []),
        input.candidateIds.length === 0 ? 1 : 0,
        input.latencyMs,
        Date.now()
      )
  }

  createImpactsForStandard(versionId: string, reason: string): void {
    const standard = this.store
      .prepareInternal(`
        SELECT r.normalized_code FROM standard_versions v
        JOIN standard_registry r ON r.id = v.standard_id WHERE v.id = ?
      `)
      .get(versionId) as { normalized_code: string } | undefined
    if (!standard) return
    const now = Date.now()
    const targets = this.store
      .prepareInternal(`
        SELECT 'method_card' AS target_type, v.method_card_id AS target_id, NULL AS project_id
        FROM method_standard_refs ref
        JOIN method_card_versions v ON v.id = ref.method_version_id
        WHERE ref.normalized_code = ?
        UNION ALL
        SELECT 'project_standard_snapshot', i.snapshot_id, s.project_id
        FROM project_standard_snapshot_items i
        JOIN project_standard_snapshots s ON s.id = i.snapshot_id
        WHERE i.version_id = ?
      `)
      .all(standard.normalized_code, versionId) as unknown as Array<{
        target_type: KnowledgeImpact['targetType']
        target_id: string
        project_id: string | null
      }>
    const insert = this.store.prepareInternal(`
      INSERT OR IGNORE INTO knowledge_impacts(
        id, project_id, trigger_type, trigger_entity_id, target_type, target_id,
        impact_type, severity, reason, status, detected_at
      ) VALUES(?, ?, 'standard_status', ?, ?, ?, 'revalidate', 'high', ?, 'open', ?)
    `)
    for (const target of targets) {
      insert.run(randomUUID(), target.project_id, versionId, target.target_type, target.target_id, reason, now)
    }
  }

  listProjectImpacts(projectId: string): KnowledgeImpact[] {
    const rows = this.store
      .prepareInternal(`
        SELECT id, trigger_type, trigger_entity_id, target_type, target_id,
          impact_type, severity, reason, status, detected_at
        FROM knowledge_impacts
        WHERE project_id = ? AND status = 'open'
        ORDER BY detected_at DESC
      `)
      .all(projectId) as unknown as ImpactRow[]
    return rows.map((row) => ({
      id: row.id,
      triggerType: row.trigger_type,
      triggerEntityId: row.trigger_entity_id,
      targetType: row.target_type,
      targetId: row.target_id,
      impactType: row.impact_type,
      severity: row.severity,
      reason: row.reason,
      status: row.status,
      detectedAt: row.detected_at
    }))
  }

  private saveMethodStandardRefs(versionId: string, card: MethodCardInput): void {
    const insert = this.store.prepareInternal(`
      INSERT INTO method_standard_refs(
        method_version_id, standard_version_id, normalized_code, clause_ref,
        purpose, required, resolution_status
      ) VALUES(?, NULL, ?, ?, ?, ?, 'unresolved')
    `)
    for (const ref of card.sourceRefs) {
      insert.run(
        versionId,
        normalizeStandardCode(ref.code),
        ref.clause || '',
        ref.purpose,
        ref.required ? 1 : 0
      )
    }
  }

  private mapMethodVersion(row: MethodVersionRow): MethodCardVersion {
    const card = JSON.parse(row.content_json) as MethodCardInput
    return {
      ...card,
      versionId: row.version_id,
      contentHash: row.content_hash,
      reviewStatus: row.review_status,
      sourceKind: row.source_kind,
      createdAt: row.created_at
    }
  }
}
