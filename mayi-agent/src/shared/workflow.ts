export const WORKFLOW_STAGES = ['requirements', 'boq', 'draft', 'deliver'] as const
export type WorkflowStage = typeof WORKFLOW_STAGES[number]
export type RunStatus = 'pending' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'stale'

export interface ProjectSummary {
  id: string
  name: string
  inputRevision: number
  createdAt: number
  updatedAt: number
}

export interface WorkflowSummary {
  id: string
  projectId: string
  status: RunStatus
  mode: 'draft' | 'formal'
  inputRevision: number
  updatedAt: number
}

export interface ArtifactSummary {
  id: string
  projectId: string
  kind: string
  name: string
  size: number
  status: 'pending' | 'ready' | 'missing' | 'hash_mismatch' | 'stale'
  createdAt: number
}
