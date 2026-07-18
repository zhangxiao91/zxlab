PRAGMA foreign_keys = ON;

CREATE TABLE signal_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  category_hint TEXT NOT NULL,
  priority INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_signal_sources_enabled ON signal_sources(enabled, priority DESC);

CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'workflow')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  success_source_count INTEGER NOT NULL DEFAULT 0,
  failed_source_count INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);
CREATE INDEX idx_collection_runs_started ON collection_runs(started_at DESC);
CREATE INDEX idx_collection_runs_status ON collection_runs(status, started_at DESC);

CREATE TABLE collection_source_runs (
  id TEXT PRIMARY KEY,
  collection_run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES signal_sources(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  cursor_value TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(collection_run_id, source_id)
);
CREATE INDEX idx_collection_source_runs_run ON collection_source_runs(collection_run_id, started_at);
CREATE INDEX idx_collection_source_runs_source ON collection_source_runs(source_id, started_at DESC);

CREATE TABLE candidate_signals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES signal_sources(id),
  external_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  category_hint TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  summary TEXT,
  content_text TEXT,
  author_json TEXT,
  published_at TEXT,
  updated_at TEXT,
  fetched_at TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  collection_run_id TEXT NOT NULL REFERENCES collection_runs(id),
  status TEXT NOT NULL CHECK (status IN ('new', 'duplicate', 'eligible', 'filtered', 'selected', 'archived')),
  event_key TEXT,
  duplicate_of TEXT REFERENCES candidate_signals(id),
  dedup_reason TEXT CHECK (dedup_reason IS NULL OR dedup_reason IN ('canonical-url', 'content-hash')),
  editorial_decision TEXT CHECK (editorial_decision IS NULL OR editorial_decision IN ('keep', 'drop', 'merge')),
  editorial_category TEXT,
  relevance REAL,
  novelty REAL,
  actionability REAL,
  source_quality REAL,
  editorial_reason TEXT,
  related_memory_ids_json TEXT,
  merge_target_candidate_id TEXT REFERENCES candidate_signals(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX idx_candidate_signals_published ON candidate_signals(published_at DESC);
CREATE INDEX idx_candidate_signals_fetched ON candidate_signals(fetched_at DESC);
CREATE INDEX idx_candidate_signals_status ON candidate_signals(status, fetched_at DESC);
CREATE INDEX idx_candidate_signals_category ON candidate_signals(category_hint, fetched_at DESC);
CREATE INDEX idx_candidate_signals_source ON candidate_signals(source_id, fetched_at DESC);
CREATE INDEX idx_candidate_signals_canonical ON candidate_signals(canonical_url);
CREATE INDEX idx_candidate_signals_hash ON candidate_signals(content_hash);
CREATE INDEX idx_candidate_signals_run ON candidate_signals(collection_run_id, fetched_at DESC);

CREATE TABLE briefing_item_candidates (
  briefing_item_id TEXT NOT NULL REFERENCES briefing_items(id) ON DELETE CASCADE,
  candidate_signal_id TEXT NOT NULL REFERENCES candidate_signals(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('primary', 'supporting')),
  PRIMARY KEY (briefing_item_id, candidate_signal_id)
);
CREATE INDEX idx_briefing_item_candidates_candidate ON briefing_item_candidates(candidate_signal_id);

ALTER TABLE briefing_runs ADD COLUMN collection_run_id TEXT REFERENCES collection_runs(id);
