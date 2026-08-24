CREATE TABLE IF NOT EXISTS research_dossiers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  current_revision_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS research_dossier_revisions (
  id TEXT PRIMARY KEY,
  dossier_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  previous_revision_id TEXT,
  previous_fingerprint TEXT,
  source_proposal_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dossier_id, revision_number),
  UNIQUE(dossier_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_research_dossier_revisions_profile_id
  ON research_dossier_revisions(profile_id, id);

CREATE TABLE IF NOT EXISTS research_dossier_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('projection', 'manual_thesis')),
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  dossier_id TEXT,
  base_key TEXT NOT NULL,
  source_run_id TEXT,
  payload_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'dismissed', 'expired', 'stale')),
  payload_json TEXT,
  confirm_idempotency_key TEXT,
  confirm_command_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK ((kind = 'projection' AND source_run_id IS NOT NULL) OR (kind = 'manual_thesis' AND source_run_id IS NULL)),
  UNIQUE(source_run_id, profile_id, base_key)
);

CREATE INDEX IF NOT EXISTS idx_research_dossier_proposals_profile_instrument_status
  ON research_dossier_proposals(profile_id, instrument_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS research_dossier_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  dossier_id TEXT,
  profile_id TEXT NOT NULL,
  proposal_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('confirmed', 'dismissed', 'expired', 'stale', 'purged')),
  before_fingerprint TEXT,
  after_fingerprint TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_dossier_audit_profile_sequence
  ON research_dossier_audit_events(profile_id, sequence);

CREATE TABLE IF NOT EXISTS alert_rule_drafts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  source_proposal_id TEXT NOT NULL,
  source_delta_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'draft'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_rule_drafts_profile_created
  ON alert_rule_drafts(profile_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS validate_alert_rule_draft_insert
BEFORE INSERT ON alert_rule_drafts
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM research_dossier_proposals
      WHERE id = NEW.source_proposal_id
        AND profile_id = NEW.profile_id
        AND (status = 'expired' OR expires_at <= NEW.created_at)
    )
      THEN RAISE(ABORT, 'DOSSIER_PROPOSAL_EXPIRED')
    WHEN NOT EXISTS (
      SELECT 1 FROM research_dossier_proposals
      WHERE id = NEW.source_proposal_id
        AND profile_id = NEW.profile_id
        AND status = 'pending'
        AND expires_at > NEW.created_at
    )
      THEN RAISE(ABORT, 'DOSSIER_PROPOSAL_NOT_PENDING')
  END;
END;

CREATE TABLE IF NOT EXISTS research_dossier_commands (
  profile_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('confirm', 'dismiss', 'manual_thesis', 'alert_draft', 'rebase', 'purge')),
  command_hash TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, idempotency_key)
);

CREATE TRIGGER IF NOT EXISTS validate_research_dossier_revision_insert
BEFORE INSERT ON research_dossier_revisions
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM research_dossier_proposals
      WHERE id = NEW.source_proposal_id
        AND profile_id = NEW.profile_id
        AND status = 'pending'
    )
      THEN RAISE(ABORT, 'DOSSIER_PROPOSAL_NOT_PENDING')
    WHEN NEW.revision_number = 1
      AND EXISTS (SELECT 1 FROM research_dossiers WHERE id = NEW.dossier_id)
      THEN RAISE(ABORT, 'DOSSIER_REVISION_CONFLICT')
    WHEN NEW.revision_number > 1
      AND NOT EXISTS (
        SELECT 1 FROM research_dossiers
        WHERE id = NEW.dossier_id
          AND profile_id = NEW.profile_id
          AND version = NEW.revision_number - 1
          AND current_revision_id = NEW.previous_revision_id
          AND current_revision_fingerprint = NEW.previous_fingerprint
      )
      THEN RAISE(ABORT, 'DOSSIER_REVISION_CONFLICT')
  END;
END;

CREATE TRIGGER IF NOT EXISTS validate_research_dossier_dismiss_command
BEFORE INSERT ON research_dossier_commands
WHEN NEW.kind = 'dismiss'
  AND NOT EXISTS (
    SELECT 1 FROM research_dossier_proposals
    WHERE id = NEW.resource_id
      AND profile_id = NEW.profile_id
      AND status = 'dismissed'
  )
BEGIN
  SELECT RAISE(ABORT, 'DOSSIER_PROPOSAL_NOT_PENDING');
END;
