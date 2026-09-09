export const PROJECT_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  workspace_relpath TEXT NOT NULL UNIQUE,
  input_revision INTEGER NOT NULL DEFAULT 0 CHECK(input_revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  category TEXT NOT NULL CHECK(category IN ('tender','amendment','boq','drawing','survey','management','reference')),
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(id, project_id),
  FOREIGN KEY(active_version_id, id, project_id) REFERENCES document_versions(id, document_id, project_id)
);
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  storage_relpath TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(document_id, project_id) REFERENCES documents(id, project_id),
  UNIQUE(id, project_id),
  UNIQUE(id, document_id, project_id),
  UNIQUE(project_id, storage_relpath)
);
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_version_id TEXT NOT NULL,
  parse_run_id TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  text TEXT NOT NULL,
  structured_json TEXT CHECK(structured_json IS NULL OR json_valid(structured_json)),
  status TEXT NOT NULL CHECK(status IN ('parsed','needs_review','failed')),
  FOREIGN KEY(document_version_id, project_id) REFERENCES document_versions(id, project_id),
  UNIQUE(id, project_id)
);
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  input_revision INTEGER NOT NULL CHECK(input_revision >= 0),
  input_manifest_json TEXT NOT NULL CHECK(json_valid(input_manifest_json)),
  mode TEXT NOT NULL CHECK(mode IN ('draft','formal')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_user','succeeded','failed','cancelled','interrupted','stale')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, project_id)
);
CREATE UNIQUE INDEX idx_active_project_run ON workflow_runs(project_id)
  WHERE status IN ('pending','running','waiting_user');
CREATE TABLE stage_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stage_key TEXT NOT NULL CHECK(stage_key IN ('requirements','boq','draft','deliver')),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','running','validating','waiting_user','succeeded','failed','cancelled','interrupted','stale')),
  input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
  output_manifest_json TEXT CHECK(output_manifest_json IS NULL OR json_valid(output_manifest_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workflow_run_id, project_id) REFERENCES workflow_runs(id, project_id),
  UNIQUE(workflow_run_id, stage_key, attempt),
  UNIQUE(id, workflow_run_id, project_id),
  UNIQUE(id, project_id)
);
CREATE UNIQUE INDEX idx_active_stage_run ON stage_runs(workflow_run_id)
  WHERE status IN ('pending','running','validating','waiting_user');
CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL CHECK(length(trim(content)) > 0),
  mandatory INTEGER NOT NULL CHECK(mandatory IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('effective','superseded','needs_review')),
  supersedes_id TEXT,
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id),
  FOREIGN KEY(supersedes_id, workflow_run_id, project_id) REFERENCES requirements(id, workflow_run_id, project_id),
  UNIQUE(id, workflow_run_id, project_id)
);
CREATE TABLE boq_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  source_chunk_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  features TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity_decimal TEXT NOT NULL CHECK(length(quantity_decimal) > 0),
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id),
  FOREIGN KEY(source_chunk_id, project_id) REFERENCES document_chunks(id, project_id),
  UNIQUE(id, workflow_run_id, project_id)
);
CREATE TABLE construction_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  method_key TEXT,
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id),
  FOREIGN KEY(parent_id, workflow_run_id, project_id) REFERENCES construction_groups(id, workflow_run_id, project_id),
  UNIQUE(id, workflow_run_id, project_id)
);
CREATE TABLE boq_group_members (
  boq_item_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  FOREIGN KEY(boq_item_id, workflow_run_id, project_id) REFERENCES boq_items(id, workflow_run_id, project_id),
  FOREIGN KEY(group_id, workflow_run_id, project_id) REFERENCES construction_groups(id, workflow_run_id, project_id)
);
CREATE TABLE sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id),
  UNIQUE(stage_run_id, section_key),
  UNIQUE(id, workflow_run_id, project_id)
);
CREATE TABLE section_links (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  requirement_id TEXT,
  group_id TEXT,
  coverage_status TEXT NOT NULL CHECK(coverage_status IN ('covered','needs_review','not_applicable')),
  CHECK((requirement_id IS NOT NULL) != (group_id IS NOT NULL)),
  FOREIGN KEY(section_id, workflow_run_id, project_id) REFERENCES sections(id, workflow_run_id, project_id),
  FOREIGN KEY(requirement_id, workflow_run_id, project_id) REFERENCES requirements(id, workflow_run_id, project_id),
  FOREIGN KEY(group_id, workflow_run_id, project_id) REFERENCES construction_groups(id, workflow_run_id, project_id)
);
CREATE TABLE evidence_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  requirement_id TEXT,
  boq_item_id TEXT,
  section_id TEXT,
  chunk_id TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  quote TEXT NOT NULL,
  CHECK((requirement_id IS NOT NULL) + (boq_item_id IS NOT NULL) + (section_id IS NOT NULL) = 1),
  FOREIGN KEY(chunk_id, project_id) REFERENCES document_chunks(id, project_id),
  FOREIGN KEY(requirement_id, workflow_run_id, project_id) REFERENCES requirements(id, workflow_run_id, project_id),
  FOREIGN KEY(boq_item_id, workflow_run_id, project_id) REFERENCES boq_items(id, workflow_run_id, project_id),
  FOREIGN KEY(section_id, workflow_run_id, project_id) REFERENCES sections(id, workflow_run_id, project_id)
);
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('blocking','warning','info')),
  question TEXT NOT NULL CHECK(length(trim(question)) > 0),
  resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json)),
  status TEXT NOT NULL CHECK(status IN ('open','resolved')),
  CHECK(status != 'resolved' OR resolution_json IS NOT NULL),
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id)
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  storage_relpath TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  validation_json TEXT NOT NULL CHECK(json_valid(validation_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','ready','missing','hash_mismatch','stale')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id),
  UNIQUE(project_id, storage_relpath)
);
CREATE TABLE workflow_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  stage_run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(workflow_run_id, project_id) REFERENCES workflow_runs(id, project_id),
  FOREIGN KEY(stage_run_id, workflow_run_id, project_id) REFERENCES stage_runs(id, workflow_run_id, project_id)
);
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_chunks_version ON document_chunks(document_version_id, parse_run_id);
CREATE INDEX idx_stage_run ON stage_runs(workflow_run_id, stage_key, attempt DESC);
CREATE INDEX idx_events_run ON workflow_events(workflow_run_id, sequence);
CREATE INDEX idx_issues_run ON issues(workflow_run_id, status, severity);
CREATE INDEX idx_artifacts_project ON artifacts(project_id, created_at DESC);
`;
