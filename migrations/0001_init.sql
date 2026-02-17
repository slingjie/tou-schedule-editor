-- Phase 1: Cloud sync schema for D1
-- All timestamps stored as ISO 8601 TEXT

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_projects_device ON projects(device_id);

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_filename TEXT,
  fingerprint TEXT,
  start_time TEXT,
  end_time TEXT,
  interval_minutes INTEGER,
  points_count INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  quality_report_json TEXT,
  r2_points_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_datasets_project ON datasets(project_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dataset_id TEXT,
  config_snapshot TEXT,
  cycles_snapshot TEXT,
  economics_snapshot TEXT,
  profit_snapshot TEXT,
  quality_snapshot TEXT,
  r2_embedded_points_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_runs_project ON runs(project_id);

CREATE TABLE run_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER,
  r2_blob_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON run_artifacts(run_id);

CREATE TABLE tou_configs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schedule_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE sync_cursors (
  device_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  PRIMARY KEY (device_id, entity_type)
);
