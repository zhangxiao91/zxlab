ALTER TABLE signal_sources ADD COLUMN source_family TEXT NOT NULL DEFAULT 'legacy-unknown';

ALTER TABLE briefing_runs ADD COLUMN fetched_count INTEGER;
ALTER TABLE briefing_runs ADD COLUMN unique_count INTEGER;
ALTER TABLE briefing_runs ADD COLUMN balanced_count INTEGER;
ALTER TABLE briefing_runs ADD COLUMN synthesis_count INTEGER;

ALTER TABLE briefings ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'legacy-unknown'
  CHECK (generation_mode IN ('model', 'deterministic-fallback', 'legacy-unknown'));
ALTER TABLE briefings ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (quality_status IN ('passed', 'degraded', 'unknown'));
