CREATE TABLE daily_pipeline_runs (
  id TEXT PRIMARY KEY,
  briefing_date TEXT NOT NULL UNIQUE,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  current_stage TEXT CHECK (current_stage IN ('collecting', 'normalizing', 'filtering', 'generating', 'validating', 'publishing', 'refreshing')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  collection_run_id TEXT,
  briefing_run_id TEXT,
  briefing_id TEXT,
  pages_refresh_status TEXT CHECK (pages_refresh_status IN ('triggered', 'not-configured')),
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  next_retry_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_daily_pipeline_runs_status ON daily_pipeline_runs(status, briefing_date DESC);

CREATE TABLE daily_pipeline_stage_events (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES daily_pipeline_runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('collecting', 'normalizing', 'filtering', 'generating', 'validating', 'publishing', 'refreshing')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT
);

CREATE INDEX idx_daily_pipeline_stage_events_run
  ON daily_pipeline_stage_events(pipeline_run_id, attempt, started_at);

CREATE UNIQUE INDEX idx_daily_pipeline_stage_once
  ON daily_pipeline_stage_events(pipeline_run_id, attempt, stage);
