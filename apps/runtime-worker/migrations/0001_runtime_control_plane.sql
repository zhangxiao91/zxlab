PRAGMA foreign_keys = ON;

CREATE TABLE runtime_probe_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE runtime_samples (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runtime_probe_runs(id),
  service_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('operational', 'degraded', 'offline', 'unknown')),
  version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  error_code TEXT,
  checks_json TEXT NOT NULL,
  public_json TEXT
);
CREATE INDEX idx_runtime_samples_latest ON runtime_samples(service_id, observed_at DESC);

CREATE TABLE runtime_incidents (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('degraded', 'offline')),
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  last_status TEXT NOT NULL
);
CREATE INDEX idx_runtime_incidents_open ON runtime_incidents(service_id, resolved_at, opened_at DESC);

CREATE TABLE runtime_activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  service_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_runtime_activities_recent ON runtime_activities(created_at DESC);
