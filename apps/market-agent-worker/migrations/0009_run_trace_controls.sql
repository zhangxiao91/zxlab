ALTER TABLE agent_runs ADD COLUMN started_at TEXT;
ALTER TABLE agent_runs ADD COLUMN completed_at TEXT;
ALTER TABLE agent_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE agent_runs ADD COLUMN last_transition_id TEXT;
ALTER TABLE agent_runs ADD COLUMN stage_started_at TEXT;

UPDATE agent_runs
SET completed_at = CASE WHEN status IN ('success', 'partial', 'failed') THEN updated_at ELSE NULL END,
    duration_ms = CASE
      WHEN status IN ('success', 'partial', 'failed')
      THEN MAX(0, CAST((julianday(updated_at) - julianday(created_at)) * 86400000 AS INTEGER))
      ELSE NULL
    END;

CREATE TABLE IF NOT EXISTS run_trace_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  type TEXT NOT NULL,
  stage TEXT,
  attempt INTEGER NOT NULL,
  recovery_generation INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  duration_ms INTEGER,
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  code TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_trace_events_profile_run_sequence
  ON run_trace_events(profile_id, run_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_trace_events_dedupe
  ON run_trace_events(run_id, type, COALESCE(stage, ''), attempt, recovery_generation);
