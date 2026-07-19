PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 48),
  platform TEXT NOT NULL CHECK(platform IN ('macos', 'android', 'ios', 'windows', 'linux', 'web')),
  capabilities TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS device_credentials (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS device_links (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  paired_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (device_id, paired_device_id)
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  claim_hash TEXT NOT NULL UNIQUE,
  desktop_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirming', 'confirmed', 'expired', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  desktop_device_id TEXT REFERENCES devices(id),
  receiver_device_id TEXT REFERENCES devices(id),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  sender_device_id TEXT NOT NULL REFERENCES devices(id),
  receiver_device_id TEXT NOT NULL REFERENCES devices(id),
  type TEXT NOT NULL CHECK(type IN ('text', 'url', 'image')),
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

CREATE TABLE IF NOT EXISTS transfer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  actor_device_id TEXT REFERENCES devices(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'opened', 'claimed', 'expired', 'failed')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON device_credentials(token_hash);
CREATE INDEX IF NOT EXISTS idx_pairing_expires_at ON pairing_sessions(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_links_device ON device_links(device_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_transfers_receiver_created ON transfers(receiver_device_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_sender_created ON transfers(sender_device_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_expiry ON transfers(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_transfer_events_transfer ON transfer_events(transfer_id, created_at);
