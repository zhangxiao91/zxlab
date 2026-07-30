export const NETEASE_PACKAGE = "com.netease.cloudmusic";
export const MUSIC_BATCH_LIMIT = 100;

export type PlaybackEventType =
  | "track_started"
  | "playback_resumed"
  | "playback_paused"
  | "track_ended"
  | "track_skipped"
  | "session_destroyed";

export type PlaybackState = "playing" | "paused" | "stopped" | "buffering" | "connecting" | "skipping" | "error" | "none";

export interface PlaybackEvent {
  eventId: string;
  sessionId: string;
  eventType: PlaybackEventType;
  packageName: typeof NETEASE_PACKAGE;
  mediaId?: string;
  fingerprint: string;
  track: {
    title: string;
    artist?: string;
    album?: string;
    durationMs?: number;
    artworkUrl?: string;
  };
  playback: {
    state: PlaybackState;
    positionMs?: number;
    speed?: number;
  };
  occurredAt: string;
  elapsedRealtimeMs: number;
}

export interface PlaybackEventBatch {
  schemaVersion: 1;
  batchId: string;
  sentAt: string;
  events: PlaybackEvent[];
}

export interface NowPlaying {
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  state: PlaybackState;
  positionMs?: number;
  durationMs?: number;
  deviceName: string;
  occurredAt: string;
}

const eventTypes = new Set<PlaybackEventType>(["track_started", "playback_resumed", "playback_paused", "track_ended", "track_skipped", "session_destroyed"]);
const playbackStates = new Set<PlaybackState>(["playing", "paused", "stopped", "buffering", "connecting", "skipping", "error", "none"]);
const idPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function validatePlaybackBatch(value: unknown, now = Date.now()): PlaybackEventBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || typeof input.batchId !== "string" || !idPattern.test(input.batchId)) return null;
  if (typeof input.sentAt !== "string" || !Number.isFinite(Date.parse(input.sentAt))) return null;
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > MUSIC_BATCH_LIMIT) return null;
  const events = input.events.flatMap((event) => {
    const parsed = validatePlaybackEvent(event, now);
    return parsed ? [parsed] : [];
  });
  if (events.length !== input.events.length || new Set(events.map((event) => event.eventId)).size !== events.length) return null;
  return { schemaVersion: 1, batchId: input.batchId, sentAt: new Date(Date.parse(input.sentAt)).toISOString(), events };
}

function validatePlaybackEvent(value: unknown, now: number): PlaybackEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const track = input.track as Record<string, unknown> | undefined;
  const playback = input.playback as Record<string, unknown> | undefined;
  const occurredAt = typeof input.occurredAt === "string" ? Date.parse(input.occurredAt) : NaN;
  if (
    typeof input.eventId !== "string" || !idPattern.test(input.eventId) ||
    typeof input.sessionId !== "string" || !idPattern.test(input.sessionId) ||
    !eventTypes.has(input.eventType as PlaybackEventType) ||
    input.packageName !== NETEASE_PACKAGE ||
    typeof input.fingerprint !== "string" || !sha256Pattern.test(input.fingerprint) ||
    !track || typeof track.title !== "string" || !cleanText(track.title, 240) ||
    !playback || !playbackStates.has(playback.state as PlaybackState) ||
    !Number.isFinite(occurredAt) || Math.abs(occurredAt - now) > 366 * 24 * 60 * 60 * 1000 ||
    typeof input.elapsedRealtimeMs !== "number" || !Number.isSafeInteger(input.elapsedRealtimeMs) || input.elapsedRealtimeMs < 0
  ) return null;
  const artworkUrl = optionalHttpsUrl(track.artworkUrl);
  if (track.artworkUrl !== undefined && track.artworkUrl !== null && !artworkUrl) return null;
  return {
    eventId: input.eventId,
    sessionId: input.sessionId,
    eventType: input.eventType as PlaybackEventType,
    packageName: NETEASE_PACKAGE,
    ...(cleanText(input.mediaId, 240) ? { mediaId: cleanText(input.mediaId, 240) } : {}),
    fingerprint: input.fingerprint,
    track: {
      title: cleanText(track.title, 240)!,
      ...(cleanText(track.artist, 240) ? { artist: cleanText(track.artist, 240) } : {}),
      ...(cleanText(track.album, 240) ? { album: cleanText(track.album, 240) } : {}),
      ...(safeNonNegative(track.durationMs) !== undefined ? { durationMs: safeNonNegative(track.durationMs) } : {}),
      ...(artworkUrl ? { artworkUrl } : {}),
    },
    playback: {
      state: playback.state as PlaybackState,
      ...(safeNonNegative(playback.positionMs) !== undefined ? { positionMs: safeNonNegative(playback.positionMs) } : {}),
      ...(typeof playback.speed === "number" && Number.isFinite(playback.speed) && playback.speed >= 0 && playback.speed <= 8 ? { speed: playback.speed } : {}),
    },
    occurredAt: new Date(occurredAt).toISOString(),
    elapsedRealtimeMs: input.elapsedRealtimeMs,
  };
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, max) : undefined;
}

function safeNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
