PRAGMA foreign_keys = ON;

CREATE TABLE watch_dossiers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  condition TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('ai-engineering', 'markets', 'zxlab')),
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
  seed_briefing_id TEXT NOT NULL REFERENCES briefings(id),
  seed_briefing_item_id TEXT NOT NULL REFERENCES briefing_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_watch_dossiers_status_updated ON watch_dossiers(status, updated_at DESC);
CREATE UNIQUE INDEX idx_watch_dossiers_seed_condition ON watch_dossiers(seed_briefing_item_id, condition);

CREATE TABLE watch_observations (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watch_dossiers(id) ON DELETE CASCADE,
  observation_type TEXT NOT NULL CHECK (observation_type IN ('created', 'update')),
  briefing_id TEXT NOT NULL REFERENCES briefings(id),
  briefing_item_id TEXT NOT NULL REFERENCES briefing_items(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(watch_id, briefing_item_id)
);
CREATE INDEX idx_watch_observations_watch_observed ON watch_observations(watch_id, observed_at DESC);
CREATE INDEX idx_watch_observations_item ON watch_observations(briefing_item_id);
