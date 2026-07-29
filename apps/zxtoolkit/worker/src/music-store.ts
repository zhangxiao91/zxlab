import type { NowPlaying, PlaybackEventBatch } from "../../shared/music";

export async function ingestPlaybackBatch(db: D1Database, deviceId: string, batch: PlaybackEventBatch) {
  const existing = await db.prepare(`SELECT event_id FROM playback_events WHERE device_id = ? AND event_id IN (${batch.events.map(() => "?").join(",")})`)
    .bind(deviceId, ...batch.events.map((event) => event.eventId))
    .all<{ event_id: string }>();
  const duplicates = new Set(existing.results.map((row) => row.event_id));
  const receivedAt = new Date().toISOString();
  const statements = batch.events.filter((event) => !duplicates.has(event.eventId)).map((event) => db.prepare(`
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
  ));
  if (statements.length) await db.batch(statements);
  return {
    batchId: batch.batchId,
    accepted: batch.events.filter((event) => !duplicates.has(event.eventId)).map((event) => event.eventId),
    duplicates: [...duplicates],
    rejected: [],
    serverTime: receivedAt,
  };
}

export async function currentPlayback(db: D1Database): Promise<NowPlaying | null> {
  const row = await db.prepare(`
    SELECT e.title, e.artist, e.album, e.artwork_url, e.playback_state, e.position_ms, e.duration_ms,
           e.occurred_at, d.name device_name
    FROM playback_events e JOIN devices d ON d.id = e.device_id
    WHERE e.occurred_at >= ?
    ORDER BY CASE WHEN e.clock_suspect = 1 THEN e.received_at ELSE e.occurred_at END DESC,
             e.received_at DESC, e.event_id DESC LIMIT 1
  `).bind(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()).first<{
    title: string; artist: string | null; album: string | null; artwork_url: string | null;
    playback_state: NowPlaying["state"]; position_ms: number | null; duration_ms: number | null;
    occurred_at: string; device_name: string;
  }>();
  if (!row) return null;
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

export async function playbackSummary(db: D1Database) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const today = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  const row = await db.prepare(`
    SELECT COUNT(*) count, COUNT(DISTINCT artist) artists
    FROM playback_events WHERE event_type = 'track_started' AND occurred_at >= ?
  `).bind(today.toISOString()).first<{ count: number; artists: number }>();
  return { playsToday: row?.count ?? 0, artistsToday: row?.artists ?? 0 };
}
