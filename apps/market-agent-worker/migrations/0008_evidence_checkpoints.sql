CREATE TABLE IF NOT EXISTS run_market_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_run_market_events_run ON run_market_events(run_id, created_at);
