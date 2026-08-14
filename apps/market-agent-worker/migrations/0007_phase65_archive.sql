ALTER TABLE agent_runs ADD COLUMN payload_purged_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_runs_profile_archive_page
  ON agent_runs(profile_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_profile_retention
  ON agent_runs(profile_id, payload_purged_at, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_retention
  ON agent_runs(payload_purged_at, created_at, id);

CREATE TABLE IF NOT EXISTS run_archive_tombstones (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  evidence_fingerprint TEXT,
  purged_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  UNIQUE(profile_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_run_archive_tombstones_profile_purged
  ON run_archive_tombstones(profile_id, purged_at DESC);
