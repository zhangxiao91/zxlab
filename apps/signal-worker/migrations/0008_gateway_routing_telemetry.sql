ALTER TABLE llm_usage_events ADD COLUMN candidate_id TEXT;
ALTER TABLE llm_usage_events ADD COLUMN capability_tier TEXT;
ALTER TABLE llm_usage_events ADD COLUMN provider_instance TEXT;
ALTER TABLE llm_usage_events ADD COLUMN provider_status_code INTEGER;

CREATE TABLE llm_routing_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  task TEXT NOT NULL,
  source TEXT NOT NULL,
  selected_tier TEXT NOT NULL,
  selection_source TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  selector_provider TEXT,
  selector_model TEXT,
  selector_fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (selector_fallback_used IN (0,1)),
  selector_attempts INTEGER NOT NULL DEFAULT 0,
  selector_trace_json TEXT NOT NULL,
  route_candidate_ids_json TEXT NOT NULL
);

CREATE INDEX idx_llm_routing_events_created_at ON llm_routing_events(created_at);
CREATE INDEX idx_llm_routing_events_request_id ON llm_routing_events(request_id);
CREATE INDEX idx_llm_routing_events_tier_created_at ON llm_routing_events(selected_tier, created_at);
