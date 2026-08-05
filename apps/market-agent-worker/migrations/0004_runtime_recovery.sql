ALTER TABLE run_dispatch_outbox ADD COLUMN last_error TEXT;
ALTER TABLE dead_letter_records ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_pending ON run_dispatch_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letter_status ON dead_letter_records(status, updated_at);
