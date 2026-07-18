PRAGMA foreign_keys = ON;

CREATE TABLE briefing_runs (
  id TEXT PRIMARY KEY,
  briefing_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  trigger_type TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES briefing_runs(id),
  briefing_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'partial', 'failed', 'superseded')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  data_origin TEXT NOT NULL CHECK (data_origin IN ('fixture', 'real')),
  generated_at TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  supersedes_id TEXT REFERENCES briefings(id)
);

CREATE UNIQUE INDEX idx_briefings_one_active_date ON briefings(briefing_date) WHERE is_active = 1;
CREATE INDEX idx_briefings_date ON briefings(briefing_date, generated_at DESC);
CREATE INDEX idx_briefings_run ON briefings(run_id);

CREATE TABLE briefing_items (
  id TEXT PRIMARY KEY,
  briefing_id TEXT NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  what_changed TEXT,
  why_it_matters TEXT NOT NULL,
  suggested_action TEXT,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE INDEX idx_briefing_items_briefing ON briefing_items(briefing_id, sort_order);

CREATE TABLE briefing_sources (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES briefing_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  publisher TEXT,
  published_at TEXT
);
CREATE INDEX idx_briefing_sources_item ON briefing_sources(item_id);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  briefing_id TEXT NOT NULL REFERENCES briefings(id),
  briefing_item_id TEXT NOT NULL REFERENCES briefing_items(id),
  selected_text TEXT NOT NULL,
  comment TEXT NOT NULL,
  action_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_briefing ON annotations(briefing_id, created_at DESC);
CREATE INDEX idx_annotations_item ON annotations(briefing_item_id, created_at DESC);

CREATE TABLE annotation_messages (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_annotation_messages_annotation ON annotation_messages(annotation_id, created_at);

CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  proposed_scope TEXT NOT NULL,
  scope_key TEXT,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_memory_candidates_annotation ON memory_candidates(annotation_id);
CREATE INDEX idx_memory_candidates_status ON memory_candidates(status, created_at DESC);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT,
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_confirmed_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX idx_memory_entries_status ON memory_entries(status, updated_at DESC);
CREATE INDEX idx_memory_entries_scope ON memory_entries(scope, scope_key, status);

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_entry_id TEXT,
  event_type TEXT NOT NULL,
  source_annotation_id TEXT REFERENCES annotations(id),
  previous_content TEXT,
  new_content TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id)
);
CREATE INDEX idx_memory_events_entry ON memory_events(memory_entry_id, created_at DESC);
CREATE INDEX idx_memory_events_annotation ON memory_events(source_annotation_id, created_at DESC);

CREATE TABLE model_invocations (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  run_id TEXT REFERENCES briefing_runs(id),
  annotation_id TEXT REFERENCES annotations(id),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT
);
CREATE INDEX idx_model_invocations_run ON model_invocations(run_id, started_at);
CREATE INDEX idx_model_invocations_annotation ON model_invocations(annotation_id, started_at);
