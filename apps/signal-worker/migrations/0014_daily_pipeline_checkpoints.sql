ALTER TABLE daily_pipeline_runs ADD COLUMN candidate_ids_json TEXT;
ALTER TABLE daily_pipeline_runs ADD COLUMN editorial_decisions_json TEXT;
ALTER TABLE daily_pipeline_runs ADD COLUMN synthesis_candidate_ids_json TEXT;
ALTER TABLE daily_pipeline_runs ADD COLUMN validated_draft_json TEXT;
