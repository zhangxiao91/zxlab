CREATE TABLE playback_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('track_started', 'playback_resumed', 'playback_paused', 'track_ended', 'track_skipped', 'session_destroyed')),
  source_package TEXT NOT NULL CHECK(source_package = 'com.netease.cloudmusic'),
  source_media_id TEXT,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  duration_ms INTEGER,
  artwork_url TEXT,
  playback_state TEXT NOT NULL,
  position_ms INTEGER,
  playback_speed REAL,
  occurred_at TEXT NOT NULL,
  elapsed_realtime_ms INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  clock_suspect INTEGER NOT NULL DEFAULT 0,
  UNIQUE(device_id, event_id)
);

CREATE INDEX idx_playback_events_device_time ON playback_events(device_id, occurred_at DESC, event_id DESC);
CREATE INDEX idx_playback_events_received ON playback_events(received_at DESC);
