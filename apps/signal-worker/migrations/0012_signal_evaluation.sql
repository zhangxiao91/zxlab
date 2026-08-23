CREATE TABLE briefing_evaluations (
  briefing_id TEXT PRIMARY KEY REFERENCES briefings(id) ON DELETE CASCADE,
  rubric_version TEXT NOT NULL,
  information_gain INTEGER CHECK (information_gain IS NULL OR information_gain BETWEEN 0 AND 2),
  personal_relevance INTEGER CHECK (personal_relevance IS NULL OR personal_relevance BETWEEN 0 AND 2),
  freshness INTEGER CHECK (freshness IS NULL OR freshness BETWEEN 0 AND 2),
  technical_balance INTEGER CHECK (technical_balance IS NULL OR technical_balance BETWEEN 0 AND 2),
  source_sufficiency INTEGER CHECK (source_sufficiency IS NULL OR source_sufficiency BETWEEN 0 AND 2),
  daily_budget_fit INTEGER CHECK (daily_budget_fit IS NULL OR daily_budget_fit BETWEEN 0 AND 2),
  lead_selection INTEGER CHECK (lead_selection IS NULL OR lead_selection BETWEEN 0 AND 2),
  three_day_value INTEGER CHECK (three_day_value IS NULL OR three_day_value BETWEEN 0 AND 2),
  evaluated_at TEXT NOT NULL
);

CREATE INDEX idx_briefing_evaluations_evaluated ON briefing_evaluations(evaluated_at DESC);

ALTER TABLE briefing_runs ADD COLUMN source_policy_version TEXT NOT NULL DEFAULT 'signal-sources-v1';
