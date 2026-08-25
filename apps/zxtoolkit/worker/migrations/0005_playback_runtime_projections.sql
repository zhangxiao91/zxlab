CREATE TABLE playback_current_projection (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  artwork_url TEXT,
  playback_state TEXT NOT NULL,
  position_ms INTEGER,
  duration_ms INTEGER,
  occurred_at TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE playback_daily_summaries (
  day TEXT PRIMARY KEY,
  plays_count INTEGER NOT NULL DEFAULT 0 CHECK(plays_count >= 0),
  artists_count INTEGER NOT NULL DEFAULT 0 CHECK(artists_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE playback_daily_artists (
  day TEXT NOT NULL REFERENCES playback_daily_summaries(day) ON DELETE CASCADE,
  artist TEXT NOT NULL,
  PRIMARY KEY(day, artist)
);

CREATE TABLE playback_projection_events (
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  projected_at TEXT NOT NULL,
  PRIMARY KEY(device_id, event_id)
);

CREATE INDEX idx_playback_events_occurred
  ON playback_events(occurred_at DESC, received_at DESC, event_id DESC);

CREATE INDEX idx_playback_events_started_occurred_artist
  ON playback_events(occurred_at DESC, artist)
  WHERE event_type = 'track_started';

INSERT INTO playback_current_projection (
  singleton_id, device_id, event_id, title, artist, album, artwork_url, playback_state,
  position_ms, duration_ms, occurred_at, effective_at, received_at
)
SELECT
  1, device_id, event_id, title, artist, album, artwork_url, playback_state,
  position_ms, duration_ms, occurred_at,
  CASE WHEN clock_suspect = 1 THEN received_at ELSE occurred_at END,
  received_at
FROM playback_events
WHERE julianday(occurred_at) >= julianday('now', '-6 hours')
ORDER BY
  CASE WHEN clock_suspect = 1 THEN received_at ELSE occurred_at END DESC,
  received_at DESC,
  event_id DESC,
  device_id DESC
LIMIT 1;

INSERT INTO playback_daily_summaries (day, plays_count, artists_count, updated_at)
SELECT
  date(occurred_at, '+8 hours'),
  COUNT(*),
  COUNT(DISTINCT artist),
  MAX(received_at)
FROM playback_events
WHERE event_type = 'track_started'
GROUP BY date(occurred_at, '+8 hours');

INSERT INTO playback_daily_artists (day, artist)
SELECT DISTINCT date(occurred_at, '+8 hours'), artist
FROM playback_events
WHERE event_type = 'track_started' AND artist IS NOT NULL;

INSERT INTO playback_projection_events (device_id, event_id, projected_at)
SELECT device_id, event_id, received_at FROM playback_events;
