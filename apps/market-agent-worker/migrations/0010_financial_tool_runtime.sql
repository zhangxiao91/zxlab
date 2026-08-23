CREATE TABLE IF NOT EXISTS financial_tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK (policy_version = 'financial-tools.v1'),
  tool_id TEXT NOT NULL CHECK (tool_id = 'company_financial_update'),
  tool_version TEXT NOT NULL CHECK (tool_version = '1'),
  ordinal INTEGER NOT NULL CHECK (ordinal = 1),
  decision TEXT NOT NULL CHECK (decision IN ('invoke', 'skip')),
  selection_source TEXT NOT NULL CHECK (selection_source IN ('model', 'policy_fallback')),
  status TEXT NOT NULL CHECK (status IN ('planned', 'skipped', 'pending', 'completed', 'failed')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  outcome TEXT CHECK (outcome IN ('operational', 'partial', 'unavailable')),
  safe_error_code TEXT,
  research_fingerprint TEXT,
  result_json TEXT,
  result_purged_at TEXT,
  selected_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'planned' AND decision = 'invoke' AND started_at IS NULL AND completed_at IS NULL AND duration_ms IS NULL AND outcome IS NULL AND safe_error_code IS NULL AND research_fingerprint IS NULL AND result_json IS NULL)
    OR (status = 'pending' AND decision = 'invoke' AND started_at IS NOT NULL AND completed_at IS NULL AND duration_ms IS NULL AND outcome IS NULL AND safe_error_code IS NULL AND research_fingerprint IS NULL AND result_json IS NULL)
    OR (status = 'completed' AND decision = 'invoke' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND duration_ms IS NOT NULL AND outcome IS NOT NULL AND safe_error_code IS NULL AND research_fingerprint IS NOT NULL)
    OR (status = 'failed' AND decision = 'invoke' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND duration_ms IS NOT NULL AND outcome IS NULL AND safe_error_code IS NOT NULL AND research_fingerprint IS NULL AND result_json IS NULL)
    OR (status = 'skipped' AND decision = 'skip' AND selection_source = 'model' AND started_at IS NULL AND completed_at IS NOT NULL AND duration_ms IS NOT NULL AND outcome IS NULL AND safe_error_code IS NULL AND research_fingerprint IS NULL AND result_json IS NULL)
  ),
  CHECK (result_purged_at IS NULL OR (status = 'completed' AND result_json IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_financial_tool_invocations_profile_run
  ON financial_tool_invocations(profile_id, run_id);

CREATE TABLE IF NOT EXISTS financial_tool_trace_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  invocation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('selected', 'skipped', 'started', 'completed', 'failed')),
  tool_id TEXT NOT NULL CHECK (tool_id = 'company_financial_update'),
  tool_version TEXT NOT NULL CHECK (tool_version = '1'),
  selection_source TEXT NOT NULL CHECK (selection_source IN ('model', 'policy_fallback')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  occurred_at TEXT NOT NULL,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT CHECK (outcome IN ('operational', 'partial', 'unavailable')),
  research_fingerprint TEXT,
  code TEXT,
  CHECK (
    (type = 'selected' AND duration_ms IS NOT NULL AND outcome IS NULL AND research_fingerprint IS NULL AND code IS NULL)
    OR (type = 'skipped' AND selection_source = 'model' AND duration_ms IS NOT NULL AND outcome IS NULL AND research_fingerprint IS NULL AND code = 'FINANCIAL_TOOL_NOT_SELECTED')
    OR (type = 'started' AND duration_ms IS NULL AND outcome IS NULL AND research_fingerprint IS NULL AND code IS NULL)
    OR (type = 'completed' AND duration_ms IS NOT NULL AND outcome IS NOT NULL AND research_fingerprint IS NOT NULL AND code IS NULL)
    OR (type = 'failed' AND duration_ms IS NOT NULL AND outcome IS NULL AND research_fingerprint IS NULL AND code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_financial_tool_trace_profile_run_sequence
  ON financial_tool_trace_events(profile_id, run_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_tool_trace_dedupe
  ON financial_tool_trace_events(invocation_id, type, attempt);
