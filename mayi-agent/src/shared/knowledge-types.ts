export type StandardLevel =
  | 'national'
  | 'industry'
  | 'anhui'
  | 'hefei'
  | 'group'
  | 'enterprise'

export type StandardStatus = 'active' | 'revised' | 'superseded' | 'abolished' | 'unknown'

export type StandardVerificationStatus =
  | 'discovered'
  | 'pending_review'
  | 'verified_official'
  | 'approved'
  | 'superseded'
  | 'abolished'
  | 'rejected'

export type MandatoryNature =
  | 'mandatory'
  | 'recommended'
  | 'partially-mandatory'
  | 'unknown'

export type FullTextAccess = 'public' | 'licensed' | 'metadata-only'
export type StandardQueryPurpose = 'draft' | 'formal'
export type StandardCacheState = 'hit' | 'stale' | 'miss' | 'negative_hit' | 'refresh_failed'
export type SnapshotMode = 'draft' | 'formal'
export type StandardSelectionReason = 'tender' | 'design' | 'mandatory' | 'regional' | 'method'

export interface StandardVersion {
  id: string
  standardId: string
  code: string
  normalizedCode: string
  title: string
  level: StandardLevel
  jurisdictions: string[]
  disciplines: string[]
  status: StandardStatus
  mandatoryNature: MandatoryNature
  verificationStatus: StandardVerificationStatus
  publishDate?: string
  effectiveDate?: string
  abolishedDate?: string
  replaces: string[]
  replacedBy: string[]
  officialSourceId: string
  officialSourceUrl: string
  fullTextAccess: FullTextAccess
  sourceHash: string
  checkedAt: number
  createdAt: number
}

export interface ManualStandardImport {
  code: string
  title: string
  level: StandardLevel
  jurisdictions: string[]
  disciplines: string[]
  status: StandardStatus
  mandatoryNature: MandatoryNature
  publishDate?: string
  effectiveDate?: string
  abolishedDate?: string
  replaces?: string[]
  replacedBy?: string[]
  officialSourceId: string
  officialSourceUrl: string
  fullTextAccess: FullTextAccess
}

export interface StandardQueryInput {
  code: string
  jurisdiction: string
  discipline?: string
  applicableDate: string
  purpose: StandardQueryPurpose
}

export interface StandardQueryResult {
  normalizedCode: string
  cacheState: StandardCacheState
  version?: StandardVersion
  usableForFormal: boolean
  checkedAt?: number
  warnings: string[]
}

export interface ProjectStandardSnapshotSelection {
  versionId: string
  selectionReason: StandardSelectionReason
}

export interface CreateProjectStandardSnapshotInput {
  sessionId: string
  applicableDate: string
  mode: SnapshotMode
  standards: ProjectStandardSnapshotSelection[]
}

export interface ProjectStandardSnapshotItem {
  code: string
  title: string
  versionId: string
  sourceHash: string
  selectionReason: StandardSelectionReason
  verificationStatus: StandardVerificationStatus
  verifiedAt: number
}

export interface ProjectStandardSnapshot {
  schemaVersion: 1
  snapshotId: string
  projectId: string
  sessionId: string
  applicableDate: string
  mode: SnapshotMode
  revision: number
  standards: ProjectStandardSnapshotItem[]
  generatedAt: number
  snapshotHash: string
  artifactRelativePath: string
}

export type MethodDiscipline =
  | 'road'
  | 'drainage'
  | 'utility'
  | 'traffic'
  | 'lighting'
  | 'landscape'
  | 'common'
export type MethodReviewStatus = 'draft' | 'reviewed' | 'approved' | 'retired' | 'rejected'
export type MethodSourceKind = 'builtin' | 'enterprise' | 'project'
export type MethodSelectionReason = 'entity' | 'risk' | 'tender' | 'design' | 'user'
export type MethodApplicability = 'applicable' | 'conditional' | 'not_applicable'

export interface MethodStandardReference {
  code: string
  clause?: string
  purpose: 'constraint' | 'quality' | 'safety' | 'acceptance' | 'test'
  required: boolean
}

export interface MethodControlPoint {
  id: string
  name: string
  value?: string | number
  unit?: string
  sourceType:
    | 'project'
    | 'standard'
    | 'design'
    | 'trial-section'
    | 'manufacturer'
    | 'enterprise-method'
    | 'assumption'
  sourceRef?: string
  required: boolean
}

export interface MethodCardInput {
  schemaVersion: 1
  id: string
  version: string
  name: string
  discipline: MethodDiscipline
  tags: string[]
  applicableFactIds: string[]
  excludedFactIds: string[]
  requiredFactIds: string[]
  workflow: Array<{ id: string; name: string }>
  controlPoints: MethodControlPoint[]
  laborRoles: string[]
  equipmentTypes: string[]
  qualityEvidence: string[]
  safetyRisks: string[]
  environmentalControls: string[]
  sourceRefs: MethodStandardReference[]
  prohibitedAssumptions: string[]
  reviewStatus: MethodReviewStatus
  reviewedAt?: string
}

export interface MethodCardVersion extends MethodCardInput {
  versionId: string
  contentHash: string
  sourceKind: MethodSourceKind
  createdAt: number
}

export interface MethodMatchInput {
  sessionId: string
  disciplines: MethodDiscipline[]
  factIds: string[]
  mode: SnapshotMode
  limit?: number
}

export interface MethodMatchCandidate {
  method: MethodCardVersion
  applicability: MethodApplicability
  matchedFactIds: string[]
  pendingFactIds: string[]
  excludedByFactIds: string[]
  warnings: string[]
}

export interface MethodMatchResult {
  factsHash: string
  candidates: MethodMatchCandidate[]
  generatedAt: number
}

export interface CreateProjectMethodSnapshotInput {
  sessionId: string
  factsHash: string
  standardSnapshotId?: string
  mode: SnapshotMode
  methods: Array<{ methodVersionId: string; selectionReason: MethodSelectionReason }>
}

export interface ProjectMethodSnapshot {
  schemaVersion: 1
  snapshotId: string
  projectId: string
  sessionId: string
  factsHash: string
  standardSnapshotId?: string
  mode: SnapshotMode
  revision: number
  methods: Array<{
    id: string
    name: string
    versionId: string
    contentHash: string
    selectionReason: MethodSelectionReason
    reviewStatus: MethodReviewStatus
    standardCodes: string[]
  }>
  generatedAt: number
  snapshotHash: string
  artifactRelativePath: string
}

export interface StandardReferenceInput {
  rawCode: string
  rawTitle?: string
  clauseRef?: string
  sourceType: 'method_card' | 'chapter' | 'planning' | 'tender' | 'design'
  sourceId: string
  sourceLocation?: string
}

export interface ValidateStandardReferencesInput {
  sessionId: string
  applicableDate: string
  mode: SnapshotMode
  references: StandardReferenceInput[]
}

export interface StandardValidationIssue {
  ruleCode: string
  severity: 'blocking' | 'high' | 'medium' | 'low'
  status: 'open'
  referenceIndex: number
  message: string
  suggestion: string
}

export interface StandardValidationReport {
  schemaVersion: 1
  runId: string
  projectId: string
  standardSnapshotId?: string
  applicableDate: string
  mode: SnapshotMode
  status: 'passed' | 'warnings' | 'blocked'
  referencesChecked: number
  issues: StandardValidationIssue[]
  generatedAt: number
  inputHash: string
  artifactRelativePath: string
}

export interface OfficialSyncScope {
  codes: string[]
  jurisdiction: string
  discipline?: string
  applicableDate: string
}

export interface OfficialSyncRun {
  id: string
  providerId: string
  status: 'succeeded' | 'partial' | 'failed'
  discovered: number
  notFound: number
  failed: number
  startedAt: number
  finishedAt: number
}

export interface KnowledgeImpact {
  id: string
  triggerType: 'standard_status' | 'standard_version' | 'method_card'
  triggerEntityId: string
  targetType: 'method_card' | 'project_standard_snapshot' | 'project_method_snapshot'
  targetId: string
  impactType: 'revalidate' | 'reselect' | 'regenerate' | 'review_only'
  severity: 'high' | 'medium' | 'low'
  reason: string
  status: 'open' | 'acknowledged' | 'resolved' | 'not_applicable'
  detectedAt: number
}
