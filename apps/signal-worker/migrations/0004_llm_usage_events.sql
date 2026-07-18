CREATE TABLE llm_usage_events (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, created_at TEXT NOT NULL,
  source TEXT NOT NULL, operation TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER,
  estimated_cost_usd REAL, latency_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('success','error','timeout','cancelled')),
  error_type TEXT, error_code TEXT, fallback_depth INTEGER NOT NULL DEFAULT 0,
  fallback_from_provider TEXT, fallback_from_model TEXT, is_streaming INTEGER NOT NULL DEFAULT 0 CHECK (is_streaming IN (0,1))
);
CREATE INDEX idx_llm_usage_events_created_at ON llm_usage_events(created_at);
CREATE INDEX idx_llm_usage_events_source_created_at ON llm_usage_events(source, created_at);
CREATE INDEX idx_llm_usage_events_model_created_at ON llm_usage_events(provider, model, created_at);
CREATE INDEX idx_llm_usage_events_status_created_at ON llm_usage_events(status, created_at);
CREATE INDEX idx_llm_usage_events_request_id ON llm_usage_events(request_id);
