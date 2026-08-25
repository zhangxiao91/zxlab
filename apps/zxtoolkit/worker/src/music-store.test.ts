import { readFileSync } from "node:fs";
import type { DatabaseSync as NodeDatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlaybackEventBatch } from "../../shared/music";
import { currentPlayback, ingestPlaybackBatch, playbackSummary, shanghaiDay } from "./music-store";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const receivedAt = "2026-08-25T01:00:00.000Z";
const sqliteModule = process.getBuiltinModule("node:sqlite");
const { DatabaseSync } = sqliteModule;

describe("playback runtime projections", () => {
  it("updates bounded projections atomically and keeps retries idempotent", async () => {
    const database = migratedDatabase();
    insertDevice(database.sqlite, "device-1", "Test Phone");
    const batch = playbackBatch([
      playbackEvent("event-0001", "2026-08-25T00:58:00.000Z", "Artist A"),
      playbackEvent("event-0002", "2026-08-25T00:59:00.000Z", "Artist A"),
    ]);

    const first = await ingestPlaybackBatch(database.binding, "device-1", batch, receivedAt);
    expect(first.accepted).toEqual(["event-0001", "event-0002"]);
    expect(await currentPlayback(database.binding, Date.parse(receivedAt))).toMatchObject({
      title: "Track event-0002",
      artist: "Artist A",
      deviceName: "Test Phone",
    });
    expect(await playbackSummary(database.binding, Date.parse(receivedAt))).toEqual({ playsToday: 2, artistsToday: 1 });

    const retry = await ingestPlaybackBatch(database.binding, "device-1", batch, "2026-08-25T01:01:00.000Z");
    expect(retry.accepted).toEqual([]);
    expect(retry.duplicates).toEqual(["event-0001", "event-0002"]);
    expect(await playbackSummary(database.binding, Date.parse(receivedAt))).toEqual({ playsToday: 2, artistsToday: 1 });

    const next = await ingestPlaybackBatch(database.binding, "device-1", playbackBatch([
      playbackEvent("event-0003", "2026-08-25T01:01:30.000Z", "Artist B"),
    ]), "2026-08-25T01:02:00.000Z");
    expect(next.accepted).toEqual(["event-0003"]);
    expect(await playbackSummary(database.binding, Date.parse(receivedAt))).toEqual({ playsToday: 3, artistsToday: 2 });

    const conflicting = playbackBatch([{ ...batch.events[1], track: { ...batch.events[1].track, title: "Conflicting retry" } }]);
    expect((await ingestPlaybackBatch(database.binding, "device-1", conflicting, "2026-08-25T01:03:00.000Z")).duplicates)
      .toEqual(["event-0002"]);
    expect((await currentPlayback(database.binding, Date.parse(receivedAt)))?.title).toBe("Track event-0003");

    database.queries.length = 0;
    await currentPlayback(database.binding, Date.parse(receivedAt));
    await playbackSummary(database.binding, Date.parse(receivedAt));
    expect(database.queries).toHaveLength(2);
    expect(database.queries.every((query) => !query.includes("FROM playback_events"))).toBe(true);
  });

  it("backfills the projections from existing playback events", async () => {
    const database = baseDatabase();
    insertDevice(database.sqlite, "device-1", "Backfill Phone");
    const now = new Date().toISOString();
    insertRawEvent(database.sqlite, "device-1", "event-backfill", now, "Backfill Artist");

    applyMigration(database.sqlite, "0005_playback_runtime_projections.sql");

    expect(database.sqlite.prepare("SELECT COUNT(*) count FROM playback_projection_events").get()).toEqual({ count: 1 });
    expect(database.sqlite.prepare("SELECT plays_count, artists_count FROM playback_daily_summaries WHERE day = ?").get(shanghaiDay(now)))
      .toEqual({ plays_count: 1, artists_count: 1 });
    expect(database.sqlite.prepare("SELECT event_id FROM playback_current_projection WHERE singleton_id = 1").get())
      .toEqual({ event_id: "event-backfill" });
  });

  it("expires the current projection after six hours without scanning history", async () => {
    const database = migratedDatabase();
    insertDevice(database.sqlite, "device-1", "Test Phone");
    await ingestPlaybackBatch(database.binding, "device-1", playbackBatch([
      playbackEvent("event-stale", receivedAt, "Artist A"),
    ]), receivedAt);

    expect(await currentPlayback(database.binding, Date.parse(receivedAt) + 6 * 60 * 60 * 1000 + 1)).toBeNull();
  });
});

function migratedDatabase() {
  const database = baseDatabase();
  applyMigration(database.sqlite, "0005_playback_runtime_projections.sql");
  return database;
}

function baseDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0001_device_delivery.sql",
    "0002_bidirectional_files.sql",
    "0003_playback_events.sql",
    "0004_delivery_idempotency.sql",
  ]) applyMigration(sqlite, name);
  const queries: string[] = [];
  return { sqlite, queries, binding: sqliteD1(sqlite, queries) };
}

function applyMigration(sqlite: NodeDatabaseSync, name: string) {
  sqlite.exec(readFileSync(`${migrationDirectory}${name}`, "utf8"));
}

function insertDevice(sqlite: NodeDatabaseSync, id: string, name: string) {
  sqlite.prepare(`
    INSERT INTO devices (id, name, platform, capabilities, created_at, credential_version)
    VALUES (?, ?, 'android', '[]', ?, 1)
  `).run(id, name, receivedAt);
}

function insertRawEvent(sqlite: NodeDatabaseSync, deviceId: string, eventId: string, occurredAt: string, artist: string) {
  sqlite.prepare(`
    INSERT INTO playback_events (
      id, device_id, event_id, session_id, event_type, source_package, fingerprint, title, artist,
      playback_state, occurred_at, elapsed_realtime_ms, received_at, clock_suspect
    ) VALUES (?, ?, ?, 'session-backfill', 'track_started', 'com.netease.cloudmusic', ?, 'Backfill Track', ?,
      'playing', ?, 1, ?, 0)
  `).run(crypto.randomUUID(), deviceId, eventId, "a".repeat(64), artist, occurredAt, occurredAt);
}

function playbackBatch(events: PlaybackEventBatch["events"]): PlaybackEventBatch {
  return { schemaVersion: 1, batchId: "batch-projection", sentAt: receivedAt, events };
}

function playbackEvent(eventId: string, occurredAt: string, artist: string): PlaybackEventBatch["events"][number] {
  return {
    eventId,
    sessionId: "session-0001",
    eventType: "track_started",
    packageName: "com.netease.cloudmusic",
    fingerprint: "a".repeat(64),
    track: { title: `Track ${eventId}`, artist, durationMs: 180_000 },
    playback: { state: "playing", positionMs: 1_200, speed: 1 },
    occurredAt,
    elapsedRealtimeMs: 1,
  };
}

function sqliteD1(sqlite: NodeDatabaseSync, queries: string[]): D1Database {
  const prepare = (query: string): D1PreparedStatement => {
    queries.push(query);
    return sqliteStatement(sqlite.prepare(query));
  };
  return {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => (statement as SqliteD1Statement).execute<T>());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 0, duration: 0 };
    },
    withSession() { throw new Error("not implemented"); },
    async dump() { throw new Error("not implemented"); },
  } as D1Database;
}

interface SqliteD1Statement extends D1PreparedStatement {
  execute<T>(): D1Result<T>;
}

function sqliteStatement(statement: StatementSync): SqliteD1Statement {
  let values: unknown[] = [];
  const result = <T>(rows: T[], changes = 0): D1Result<T> => ({
    success: true,
    results: rows,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  });
  async function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = statement.all(...sqlValues(values)).map((row) => Object.values(row) as T);
    return options?.columnNames
      ? [statement.columns().map((column) => column.name), ...rows]
      : rows;
  }
  const prepared: SqliteD1Statement = {
    bind(...bound: unknown[]) { values = bound; return prepared; },
    async first<T = Record<string, unknown>>(column?: string) {
      const row = statement.get(...sqlValues(values)) as T | undefined;
      if (!row) return null;
      return column ? (row as Record<string, unknown>)[column] as T : row;
    },
    async run<T = Record<string, unknown>>() { return prepared.execute<T>(); },
    async all<T = Record<string, unknown>>() { return prepared.execute<T>(); },
    raw,
    execute<T>() {
      if (statement.columns().length) return result(statement.all(...sqlValues(values)) as T[]);
      const changes = Number(statement.run(...sqlValues(values)).changes);
      return result<T>([], changes);
    },
  };
  return prepared;
}

function sqlValues(values: unknown[]): SQLInputValue[] {
  return values.map((value) => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
    throw new TypeError("Unsupported SQLite test binding");
  });
}
