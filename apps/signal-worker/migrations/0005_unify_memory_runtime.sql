INSERT OR IGNORE INTO memory_items (
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
  content, confidence, confidence, 'legacy_memory_entry', id,
  CASE WHEN status = 'active' THEN 'active' ELSE 'forgotten' END,
  created_at, updated_at, expires_at
FROM memory_entries;

INSERT OR IGNORE INTO memory_consolidation_candidates (
  id, action, reason, memory_id, namespace, kind, content, importance, confidence,
  source_event_ids_json, status, created_at, resolved_at
)
SELECT
  id, 'create', reason, NULL,
  CASE
    WHEN proposed_scope = 'project' AND scope_key IN ('global', 'briefing', 'markets', 'coding', 'zxlab') THEN scope_key
    WHEN proposed_scope = 'project' THEN 'zxlab'
    WHEN proposed_scope = 'preference' THEN 'global'
    ELSE 'briefing'
  END,
  CASE proposed_scope WHEN 'preference' THEN 'preference' WHEN 'belief' THEN 'fact' WHEN 'project' THEN 'decision' ELSE 'summary' END,
  content, confidence, confidence, json_array(annotation_id), status, created_at, resolved_at
FROM memory_candidates;
