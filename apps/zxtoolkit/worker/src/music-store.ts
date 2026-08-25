import type { NowPlaying, PlaybackEvent, PlaybackEventBatch } from "../../shared/music";

const CURRENT_PLAYBACK_WINDOW_MS = 6 * 60 * 60 * 1000;

interface CurrentPlaybackRow {
  title: string;
  artist: string | null;
  album: string | null;
  artwork_url: string | null;
  playback_state: NowPlaying["state"];
  position_ms: number | null;
  duration_ms: number | null;
  occurred_at: string;
  device_name: string;
}

interface DailySummaryRow {
  plays_count: number;
  artists_count: number;
}

export async function ingestPlaybackBatch(
  db: D1Database,
  deviceId: string,
  batch: PlaybackEventBatch,
  receivedAt = new Date().toISOString(),
) {
  const statements: D1PreparedStatement[] = [];
  const projectionIndexes: number[] = [];
  for (const event of batch.events) {
    statements.push(playbackEventStatement(db, deviceId, event, receivedAt));
    projectionIndexes.push(statements.length);
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO playback_projection_events (device_id, event_id, projected_at)
      SELECT ?, ?, ? WHERE changes() > 0
    `).bind(deviceId, event.eventId, receivedAt));
    if (event.eventType === "track_started") {
      statements.push(dailySummaryStatement(db, event, receivedAt));
      if (event.track.artist) {
        statements.push(db.prepare(`
          INSERT OR IGNORE INTO playback_daily_artists (day, artist)
          SELECT ?, ? WHERE changes() > 0
        `).bind(shanghaiDay(event.occurredAt), event.track.artist));
        statements.push(db.prepare(`
          UPDATE playback_daily_summaries
          SET artists_count = artists_count + 1, updated_at = MAX(updated_at, ?)
          WHERE day = ? AND changes() > 0
        `).bind(receivedAt, shanghaiDay(event.occurredAt)));
      }
    }
    if (Date.parse(event.occurredAt) >= Date.parse(receivedAt) - CURRENT_PLAYBACK_WINDOW_MS) {
      statements.push(currentProjectionStatement(db, deviceId, event, receivedAt));
    }
  }
  const results = await db.batch(statements);
  const accepted = batch.events.filter((_, index) => Number(results[projectionIndexes[index]]?.meta.changes ?? 0) === 1);
  const duplicates = batch.events.filter((_, index) => Number(results[projectionIndexes[index]]?.meta.changes ?? 0) !== 1);
  return {
    batchId: batch.batchId,
    accepted: accepted.map((event) => event.eventId),
    duplicates: duplicates.map((event) => event.eventId),
    rejected: [],
    serverTime: receivedAt,
  };
}

function playbackEventStatement(db: D1Database, deviceId: string, event: PlaybackEvent, receivedAt: string): D1PreparedStatement {
  return db.prepare(`
    INSERT OR IGNORE INTO playback_events (
      id, device_id, event_id, session_id, event_type, source_package, source_media_id, fingerprint,
      title, artist, album, duration_ms, artwork_url, playback_state, position_ms, playback_speed,
      occurred_at, elapsed_realtime_ms, received_at, clock_suspect
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), deviceId, event.eventId, event.sessionId, event.eventType, event.packageName,
    event.mediaId ?? null, event.fingerprint, event.track.title, event.track.artist ?? null, event.track.album ?? null,
    event.track.durationMs ?? null, event.track.artworkUrl ?? null, event.playback.state, event.playback.positionMs ?? null,
    event.playback.speed ?? null, event.occurredAt, event.elapsedRealtimeMs, receivedAt,
    Math.abs(Date.parse(event.occurredAt) - Date.parse(receivedAt)) > 10 * 60 * 1000 ? 1 : 0,
  );
}

function currentProjectionStatement(db: D1Database, deviceId: string, event: PlaybackEvent, receivedAt: string): D1PreparedStatement {
  const clockSuspect = Math.abs(Date.parse(event.occurredAt) - Date.parse(receivedAt)) > 10 * 60 * 1000;
  const effectiveAt = clockSuspect ? receivedAt : event.occurredAt;
  return db.prepare(`
    INSERT INTO playback_current_projection (
      singleton_id, device_id, event_id, title, artist, album, artwork_url, playback_state,
      position_ms, duration_ms, occurred_at, effective_at, received_at
    )
    SELECT 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM playback_projection_events
      WHERE device_id = ? AND event_id = ? AND projected_at = ?
    )
    ON CONFLICT(singleton_id) DO UPDATE SET
      device_id = excluded.device_id,
      event_id = excluded.event_id,
      title = excluded.title,
      artist = excluded.artist,
      album = excluded.album,
      artwork_url = excluded.artwork_url,
      playback_state = excluded.playback_state,
      position_ms = excluded.position_ms,
      duration_ms = excluded.duration_ms,
      occurred_at = excluded.occurred_at,
      effective_at = excluded.effective_at,
      received_at = excluded.received_at
    WHERE excluded.effective_at > playback_current_projection.effective_at
      OR (excluded.effective_at = playback_current_projection.effective_at AND excluded.received_at > playback_current_projection.received_at)
      OR (excluded.effective_at = playback_current_projection.effective_at AND excluded.received_at = playback_current_projection.received_at AND excluded.event_id > playback_current_projection.event_id)
      OR (excluded.effective_at = playback_current_projection.effective_at AND excluded.received_at = playback_current_projection.received_at AND excluded.event_id = playback_current_projection.event_id AND excluded.device_id > playback_current_projection.device_id)
  `).bind(
    deviceId,
    event.eventId,
    event.track.title,
    event.track.artist ?? null,
    event.track.album ?? null,
    event.track.artworkUrl ?? null,
    event.playback.state,
    event.playback.positionMs ?? null,
    event.track.durationMs ?? null,
    event.occurredAt,
    effectiveAt,
    receivedAt,
    deviceId,
    event.eventId,
    receivedAt,
  );
}

function dailySummaryStatement(db: D1Database, event: PlaybackEvent, receivedAt: string): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO playback_daily_summaries (day, plays_count, artists_count, updated_at)
    SELECT ?, 1, 0, ? WHERE changes() > 0
    ON CONFLICT(day) DO UPDATE SET
      plays_count = playback_daily_summaries.plays_count + 1,
      updated_at = MAX(playback_daily_summaries.updated_at, excluded.updated_at)
  `).bind(shanghaiDay(event.occurredAt), receivedAt);
}

export async function currentPlayback(db: D1Database, now = Date.now()): Promise<NowPlaying | null> {
  const row = await db.prepare(`
    SELECT p.title, p.artist, p.album, p.artwork_url, p.playback_state, p.position_ms, p.duration_ms,
           p.occurred_at, d.name device_name
    FROM playback_current_projection p
    JOIN devices d ON d.id = p.device_id
    WHERE p.singleton_id = 1
  `).first<CurrentPlaybackRow>();
  if (!row || Date.parse(row.occurred_at) < now - CURRENT_PLAYBACK_WINDOW_MS) return null;
  return {
    title: row.title,
    ...(row.artist ? { artist: row.artist } : {}),
    ...(row.album ? { album: row.album } : {}),
    ...(row.artwork_url ? { artworkUrl: row.artwork_url } : {}),
    state: row.playback_state,
    ...(row.position_ms !== null ? { positionMs: row.position_ms } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    deviceName: row.device_name,
    occurredAt: row.occurred_at,
  };
}

export async function playbackSummary(db: D1Database, now = Date.now()) {
  const row = await db.prepare(`
    SELECT plays_count, artists_count FROM playback_daily_summaries WHERE day = ?
  `).bind(shanghaiDay(now)).first<DailySummaryRow>();
  return { playsToday: row?.plays_count ?? 0, artistsToday: row?.artists_count ?? 0 };
}

export function shanghaiDay(value: string | number | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
