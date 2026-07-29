import { describe, expect, it } from "vitest";
import { NETEASE_PACKAGE, validatePlaybackBatch } from "../../shared/music";

const now = Date.parse("2026-07-30T12:00:00.000Z");
const event = {
  eventId: "evt_01J12345",
  sessionId: "ses_01J12345",
  eventType: "track_started",
  packageName: NETEASE_PACKAGE,
  fingerprint: "a".repeat(64),
  track: { title: "  Example   Song ", artist: "Artist", artworkUrl: "https://example.com/cover.jpg" },
  playback: { state: "playing", positionMs: 1200, speed: 1 },
  occurredAt: new Date(now).toISOString(),
  elapsedRealtimeMs: 42,
};

describe("music event contract", () => {
  it("normalizes a bounded NetEase batch", () => {
    const result = validatePlaybackBatch({ schemaVersion: 1, batchId: "batch_01J12345", sentAt: new Date(now).toISOString(), events: [event] }, now);
    expect(result?.events[0].track.title).toBe("Example Song");
  });

  it("rejects other packages and non-https artwork", () => {
    expect(validatePlaybackBatch({ schemaVersion: 1, batchId: "batch_01J12345", sentAt: new Date(now).toISOString(), events: [{ ...event, packageName: "other.player" }] }, now)).toBeNull();
    expect(validatePlaybackBatch({ schemaVersion: 1, batchId: "batch_01J12345", sentAt: new Date(now).toISOString(), events: [{ ...event, track: { ...event.track, artworkUrl: "content://cover" } }] }, now)).toBeNull();
  });

  it("rejects oversized batches", () => {
    expect(validatePlaybackBatch({ schemaVersion: 1, batchId: "batch_01J12345", sentAt: new Date(now).toISOString(), events: Array.from({ length: 101 }, (_, index) => ({ ...event, eventId: `evt_01J${String(index).padStart(5, "0")}` })) }, now)).toBeNull();
  });
});
