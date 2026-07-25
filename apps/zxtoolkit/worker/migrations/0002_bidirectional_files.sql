CREATE TABLE transfer_events_backup AS SELECT * FROM transfer_events;
DROP TABLE transfer_events;

ALTER TABLE transfers RENAME TO transfers_legacy;

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  sender_device_id TEXT NOT NULL REFERENCES devices(id),
  receiver_device_id TEXT NOT NULL REFERENCES devices(id),
  type TEXT NOT NULL CHECK(type IN ('text', 'url', 'image', 'file')),
  text_content TEXT,
  url TEXT,
  title TEXT,
  file_name TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  object_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'opened', 'claimed', 'expired', 'failed')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status_updated_at TEXT NOT NULL
);

INSERT INTO transfers SELECT * FROM transfers_legacy;
DROP TABLE transfers_legacy;

CREATE TABLE transfer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  actor_device_id TEXT REFERENCES devices(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'opened', 'claimed', 'expired', 'failed')),
  created_at TEXT NOT NULL
);

INSERT INTO transfer_events SELECT * FROM transfer_events_backup;
DROP TABLE transfer_events_backup;

CREATE INDEX IF NOT EXISTS idx_transfers_receiver_created ON transfers(receiver_device_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_sender_created ON transfers(sender_device_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_expiry ON transfers(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_transfer_events_transfer ON transfer_events(transfer_id, created_at);
