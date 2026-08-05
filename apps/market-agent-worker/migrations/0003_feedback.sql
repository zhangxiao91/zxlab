CREATE TABLE IF NOT EXISTS agent_feedback (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, profile_id TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, profile_id));
