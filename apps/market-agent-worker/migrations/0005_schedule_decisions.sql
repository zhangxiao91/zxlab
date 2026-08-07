CREATE TABLE IF NOT EXISTS agent_schedule_decisions (
  workflow TEXT NOT NULL,
  market_date TEXT NOT NULL,
  decision TEXT NOT NULL,
  calendar_source TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (workflow, market_date)
);
