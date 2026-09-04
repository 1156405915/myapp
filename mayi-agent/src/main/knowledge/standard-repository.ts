import { randomUUID } from 'node:crypto'
import type {
  ManualStandardImport,
  ProjectStandardSnapshot,
  StandardQueryInput,
  StandardSelectionReason,
  StandardVerificationStatus,
  StandardVersion
} from '../../shared/knowledge-types'
import type { AppStore } from '../store/app-store'
import { normalizeStandardCode, normalizeStringList } from './standard-code'

interface RegistryRow {
  id: string
  normalized_code: string
  display_code: string
  title: string
  level: StandardVersion['level']
  jurisdiction_json: string
  disciplines_json: string
}

interface VersionRow extends RegistryRow {
  version_id: string
  standard_id: string
  status: StandardVersion['status']
  mandatory_nature: StandardVersion['mandatoryNature']
  verification_status: StandardVerificationStatus
  publish_date: string | null
  effective_date: string | null
  abolished_date: string | null
  replaces_json: string
  replaced_by_json: string
  official_source_id: string
  official_source_url: string
  full_text_access: StandardVersion['fullTextAccess']
  source_hash: string
  checked_at: number
  created_at: number
}

interface QueryRow {
  result_status: 'found' | 'not_found' | 'failed'
  resolved_version_id: string | null
  queried_at: number
  expires_at: number
  error_code: string | null
}

/** 封装标准登记、缓存审计和项目快照所需的参数化 SQLite 操作。 */
export class StandardRepository {
  constructor(private readonly store: AppStore) {}

  upsertImportedStandard(input: ManualStandardImport, sourceHash: string, now: number): StandardVersion {
    const normalizedCode = normalizeStandardCode(input.code)
    const jurisdictions = normalizeStringList(input.jurisdictions, '适用地区')
    const disciplines = normalizeStringList(input.disciplines, '专业范围')
    const jurisdictionJson = JSON.stringify(jurisdictions)

    return this.store.runInTransaction(() => {
      let registry = this.store
        .prepareInternal(
          'SELECT * FROM standard_registry WHERE normalized_code = ? AND jurisdiction_json = ?'
        )
        .get(normalizedCode, jurisdictionJson) as RegistryRow | undefined
      if (!registry) {
        const id = randomUUID()
        this.store
          .prepareInternal(`
            INSERT INTO standard_registry(
              id, normalized_code, display_code, title, level, jurisdiction_json,
              disciplines_json, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            id,
            normalizedCode,
            input.code.trim(),
            input.title.trim(),
            input.level,
            jurisdictionJson,
            JSON.stringify(disciplines),
            now,
            now
          )
        registry = {
          id,
          normalized_code: normalizedCode,
          display_code: input.code.trim(),
          title: input.title.trim(),
          level: input.level,
          jurisdiction_json: jurisdictionJson,
          disciplines_json: JSON.stringify(disciplines)
        }
      } else {
        this.store
          .prepareInternal(`
            UPDATE standard_registry
            SET display_code = ?, title = ?, level = ?, disciplines_json = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(
            input.code.trim(),
            input.title.trim(),
            input.level,
            JSON.stringify(disciplines),
            now,
            registry.id
          )
      }

      const existing = this.store
        .prepareInternal(`
          SELECT v.id AS version_id
          FROM standard_versions v
          WHERE v.standard_id = ? AND v.effective_date IS ? AND v.source_hash = ?
        `)
        .get(registry.id, input.effectiveDate ?? null, sourceHash) as { version_id: string } | undefined
      const versionId = existing?.version_id || randomUUID()
      if (existing) {
        this.store
          .prepareInternal('UPDATE standard_versions SET checked_at = ? WHERE id = ?')
          .run(now, versionId)
      } else {
        this.store
          .prepareInternal(`
            INSERT INTO standard_versions(
              id, standard_id, status, mandatory_nature, verification_status,
              publish_date, effective_date, abolished_date, replaces_json, replaced_by_json,
              official_source_id, official_source_url, full_text_access, source_hash,
              checked_at, created_at
            ) VALUES(?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            versionId,
            registry.id,
            input.status,
            input.mandatoryNature,
            input.publishDate ?? null,
            input.effectiveDate ?? null,
            input.abolishedDate ?? null,
            JSON.stringify(input.replaces || []),
            JSON.stringify(input.replacedBy || []),
            input.officialSourceId,
            input.officialSourceUrl,
            input.fullTextAccess,
            sourceHash,
            now,
            now
          )
      }
      const version = this.getVersion(versionId)
      if (!version) throw new Error('标准版本写入失败')
      return version
    })
  }

  setVerificationStatus(versionId: string, status: StandardVerificationStatus): StandardVersion {
    const result = this.store
      .prepareInternal('UPDATE standard_versions SET verification_status = ? WHERE id = ?')
      .run(status, versionId)
    if (result.changes !== 1) throw new Error('标准版本不存在')
    const version = this.getVersion(versionId)
    if (!version) throw new Error('标准版本不存在')
    return version
  }

  appendReview(input: {
    entityType: 'standard_version' | 'official_record'
    entityId: string
    previousStatus?: string
    decision: string
    reviewerType: 'user' | 'system'
    reason: string
    evidenceRefs?: string[]
  }): void {
    this.store
      .prepareInternal(`
        INSERT INTO knowledge_reviews(
          id, entity_type, entity_id, previous_status, decision,
          reviewer_type, reason, evidence_refs_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        input.entityType,
        input.entityId,
        input.previousStatus ?? null,
        input.decision,
        input.reviewerType,
        input.reason,
        JSON.stringify(input.evidenceRefs || []),
        Date.now()
      )
  }

  startOfficialSync(providerId: string, scope: object, startedAt: number): string {
    const id = randomUUID()
    this.store
      .prepareInternal(`
        INSERT INTO official_sync_runs(id, provider_id, scope_json, status, started_at)
        VALUES(?, ?, ?, 'running', ?)
      `)
      .run(id, providerId, JSON.stringify(scope), startedAt)
    return id
  }

  saveOfficialSourceRecord(input: {
    syncRunId: string
    providerId: string
    externalId: string
    requestedUrl: string
    finalUrl: string
    contentType: string
    contentLength: number
    responseHash: string
    metadata: object
    fetchedAt: number
  }): void {
    this.store
      .prepareInternal(`
        INSERT OR IGNORE INTO official_source_records(
          id, sync_run_id, provider_id, record_type, external_id,
          requested_url, final_url, content_type, content_length,
          response_hash, payload_json, review_status, fetched_at
        ) VALUES(?, ?, ?, 'catalog', ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)
      `)
      .run(
        randomUUID(),
        input.syncRunId,
        input.providerId,
        input.externalId,
        input.requestedUrl,
        input.finalUrl,
        input.contentType,
        input.contentLength,
        input.responseHash,
        JSON.stringify(input.metadata),
        input.fetchedAt
      )
  }

  finishOfficialSync(input: {
    runId: string
    status: 'succeeded' | 'partial' | 'failed'
    discovered: number
    notFound: number
    failed: number
    finishedAt: number
    errorSummary?: string
  }): void {
    this.store
      .prepareInternal(`
        UPDATE official_sync_runs SET
          status = ?, discovered_count = ?, not_found_count = ?, failed_count = ?,
          finished_at = ?, error_summary = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        input.discovered,
        input.notFound,
        input.failed,
        input.finishedAt,
        input.errorSummary ?? null,
        input.runId
      )
  }

  getVersion(versionId: string): StandardVersion | undefined {
    const row = this.store
      .prepareInternal(`${this.versionSelectSql()} WHERE v.id = ?`)
      .get(versionId) as VersionRow | undefined
    return row ? this.mapVersion(row) : undefined
  }

  findApplicableVersion(input: StandardQueryInput): StandardVersion | undefined {
    const rows = this.store
      .prepareInternal(`${this.versionSelectSql()} WHERE r.normalized_code = ?`)
      .all(normalizeStandardCode(input.code)) as unknown as VersionRow[]
    const candidates = rows
      .map((row) => this.mapVersion(row))
      .filter((version) => version.jurisdictions.includes(input.jurisdiction))
      .filter((version) => !input.discipline || version.disciplines.includes(input.discipline))
      .filter((version) => !version.effectiveDate || version.effectiveDate <= input.applicableDate)
      .filter((version) => !version.abolishedDate || input.applicableDate < version.abolishedDate)
      .filter((version) => version.verificationStatus !== 'rejected')
      .sort((left, right) => (right.effectiveDate || '').localeCompare(left.effectiveDate || ''))
    return candidates[0]
  }

  getCachedQuery(queryKey: string): QueryRow | undefined {
    return this.store
      .prepareInternal(`
        SELECT result_status, resolved_version_id, queried_at, expires_at, error_code
        FROM standard_queries WHERE query_key = ?
      `)
      .get(queryKey) as QueryRow | undefined
  }

  saveQuery(input: {
    queryKey: string
    query: StandardQueryInput
    sourceId: string
    resultStatus: QueryRow['result_status']
    resolvedVersionId?: string
    responseHash?: string
    summary?: object
    queriedAt: number
    expiresAt: number
    errorCode?: string
  }): void {
    this.store
      .prepareInternal(`
        INSERT INTO standard_queries(
          id, query_key, normalized_code, jurisdiction, discipline, applicable_date,
          source_id, result_status, resolved_version_id, response_hash,
          response_summary_json, queried_at, expires_at, error_code
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(query_key) DO UPDATE SET
          source_id = excluded.source_id,
          result_status = excluded.result_status,
          resolved_version_id = excluded.resolved_version_id,
          response_hash = excluded.response_hash,
          response_summary_json = excluded.response_summary_json,
          queried_at = excluded.queried_at,
          expires_at = excluded.expires_at,
          error_code = excluded.error_code
      `)
      .run(
        randomUUID(),
        input.queryKey,
        normalizeStandardCode(input.query.code),
        input.query.jurisdiction,
        input.query.discipline ?? null,
        input.query.applicableDate,
        input.sourceId,
        input.resultStatus,
        input.resolvedVersionId ?? null,
        input.responseHash ?? null,
        input.summary ? JSON.stringify(input.summary) : null,
        input.queriedAt,
        input.expiresAt,
        input.errorCode ?? null
      )
  }

  nextSnapshotRevision(projectId: string): number {
    const row = this.store
      .prepareInternal(
        'SELECT COALESCE(MAX(revision), 0) AS revision FROM project_standard_snapshots WHERE project_id = ?'
      )
      .get(projectId) as { revision: number }
    return Number(row.revision) + 1
  }

  saveSnapshot(
    snapshot: ProjectStandardSnapshot,
    workspace: string,
    selections: Array<{ versionId: string; selectionReason: StandardSelectionReason }>
  ): void {
    this.store.runInTransaction(() => {
      this.store
        .prepareInternal(`
          INSERT INTO project_standard_snapshots(
            id, project_id, session_id, workspace_canonical_path, applicable_date,
            mode, revision, snapshot_json, snapshot_hash, artifact_relative_path,
            created_at, artifact_state
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `)
        .run(
          snapshot.snapshotId,
          snapshot.projectId,
          snapshot.sessionId,
          workspace,
          snapshot.applicableDate,
          snapshot.mode,
          snapshot.revision,
          JSON.stringify(snapshot),
          snapshot.snapshotHash,
          snapshot.artifactRelativePath,
          snapshot.generatedAt
        )
      const insertItem = this.store.prepareInternal(`
        INSERT INTO project_standard_snapshot_items(
          snapshot_id, version_id, selection_reason, verification_status, verified_at
        ) VALUES(?, ?, ?, ?, ?)
      `)
      for (const selection of selections) {
        const version = this.getVersion(selection.versionId)
        if (!version) throw new Error('快照包含不存在的标准版本')
        insertItem.run(
          snapshot.snapshotId,
          version.id,
          selection.selectionReason,
          version.verificationStatus,
          version.checkedAt
        )
      }
    })
  }

  setSnapshotArtifactState(
    snapshotId: string,
    state: 'ready' | 'missing' | 'hash_mismatch'
  ): void {
    this.store
      .prepareInternal('UPDATE project_standard_snapshots SET artifact_state = ? WHERE id = ?')
      .run(state, snapshotId)
  }

  getLatestSnapshot(sessionId: string): ProjectStandardSnapshot | undefined {
    const row = this.store
      .prepareInternal(`
        SELECT snapshot_json FROM project_standard_snapshots
        WHERE session_id = ? AND artifact_state = 'ready' ORDER BY revision DESC LIMIT 1
      `)
      .get(sessionId) as { snapshot_json: string } | undefined
    return row ? (JSON.parse(row.snapshot_json) as ProjectStandardSnapshot) : undefined
  }

  private versionSelectSql(): string {
    return `
      SELECT
        r.id, r.normalized_code, r.display_code, r.title, r.level,
        r.jurisdiction_json, r.disciplines_json,
        v.id AS version_id, v.standard_id, v.status, v.mandatory_nature,
        v.verification_status, v.publish_date, v.effective_date, v.abolished_date,
        v.replaces_json, v.replaced_by_json, v.official_source_id,
        v.official_source_url, v.full_text_access, v.source_hash,
        v.checked_at, v.created_at
      FROM standard_versions v
      JOIN standard_registry r ON r.id = v.standard_id
    `
  }

  private mapVersion(row: VersionRow): StandardVersion {
    return {
      id: row.version_id,
      standardId: row.standard_id,
      code: row.display_code,
      normalizedCode: row.normalized_code,
      title: row.title,
      level: row.level,
      jurisdictions: JSON.parse(row.jurisdiction_json) as string[],
      disciplines: JSON.parse(row.disciplines_json) as string[],
      status: row.status,
      mandatoryNature: row.mandatory_nature,
      verificationStatus: row.verification_status,
      publishDate: row.publish_date || undefined,
      effectiveDate: row.effective_date || undefined,
      abolishedDate: row.abolished_date || undefined,
      replaces: JSON.parse(row.replaces_json) as string[],
      replacedBy: JSON.parse(row.replaced_by_json) as string[],
      officialSourceId: row.official_source_id,
      officialSourceUrl: row.official_source_url,
      fullTextAccess: row.full_text_access,
      sourceHash: row.source_hash,
      checkedAt: row.checked_at,
      createdAt: row.created_at
    }
  }
}
