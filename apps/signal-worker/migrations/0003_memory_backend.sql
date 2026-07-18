PRAGMA foreign_keys = ON;

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL CHECK (namespace IN ('global', 'briefing', 'markets', 'coding', 'zxlab')),
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'decision', 'summary')),
  content TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_type TEXT NOT NULL,
  source_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'forgotten')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX idx_memory_items_retrieval ON memory_items(status, namespace, updated_at DESC);
CREATE INDEX idx_memory_items_source ON memory_items(source_type, source_id);

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('like', 'dislike', 'save', 'dismiss', 'comment')),
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_events_recent ON feedback_events(created_at DESC);
CREATE INDEX idx_feedback_events_target ON feedback_events(target_type, target_id, created_at DESC);

CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(id),
  old_content TEXT NOT NULL,
  new_content TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_revisions_memory ON memory_revisions(memory_id, created_at DESC);

CREATE TABLE memory_consolidation_candidates (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'ignore')),
  reason TEXT NOT NULL,
  memory_id TEXT REFERENCES memory_items(id),
  namespace TEXT,
  kind TEXT,
  content TEXT,
  importance REAL,
  confidence REAL,
  source_event_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_memory_consolidation_status ON memory_consolidation_candidates(status, created_at DESC);

INSERT INTO memory_items (
  id, namespace, kind, content, importance, confidence, source_type, source_id,
  status, created_at, updated_at, expires_at
)
SELECT
  id,
  CASE
    WHEN scope = 'project' AND scope_key IN ('global', 'briefing', 'markets', 'coding', 'zxlab') THEN scope_key
    WHEN scope = 'project' THEN 'zxlab'
    WHEN scope = 'preference' THEN 'global'
    ELSE 'briefing'
  END,
  CASE scope WHEN 'preference' THEN 'preference' WHEN 'belief' THEN 'fact' WHEN 'project' THEN 'decision' ELSE 'summary' END,
  content,
  confidence,
  confidence,
  'legacy_memory_entry',
  id,
  CASE WHEN status = 'active' THEN 'active' ELSE 'forgotten' END,
  created_at,
  updated_at,
  expires_at
FROM memory_entries;
