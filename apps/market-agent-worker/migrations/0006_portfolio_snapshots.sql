ALTER TABLE market_agent_profiles ADD COLUMN current_portfolio_snapshot_id TEXT;
ALTER TABLE agent_runs ADD COLUMN portfolio_snapshot_id TEXT;

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  cash REAL NOT NULL,
  rules_version TEXT NOT NULL,
  reliable INTEGER NOT NULL,
  warnings_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stopped_at TEXT,
  UNIQUE(profile_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_profile_expiry ON portfolio_snapshots(profile_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_portfolio_snapshot ON agent_runs(profile_id, portfolio_snapshot_id);

CREATE TABLE IF NOT EXISTS portfolio_purge_tombstones (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  purged_run_count INTEGER NOT NULL,
  scope TEXT NOT NULL
);
