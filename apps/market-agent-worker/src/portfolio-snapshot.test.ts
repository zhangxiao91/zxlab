import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePortfolioSnapshotFingerprint,
  normalizePortfolioSnapshotUpload,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
  PORTFOLIO_SNAPSHOT_MAX_TTL_MS,
  type PortfolioSnapshotUpload,
} from "@zxlab/market-agent-schema";
import { D1PortfolioSnapshotRepository } from "./portfolio-snapshot-repository.ts";

const NOW = Date.parse("2026-08-07T08:00:00.000Z");

function upload(overrides: Partial<PortfolioSnapshotUpload> = {}): PortfolioSnapshotUpload {
  return {
    schemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
    sourceRevision: "risk:confirmed-snapshot",
    calculatedAt: "2026-08-07T07:30:00.000Z",
    effectiveAt: "2026-08-07T08:00:00.000Z",
    expiresAt: "2026-08-08T08:00:00.000Z",
    positions: [
      { instrumentId: "SSE:600000", quantity: 100, averageCost: 10 },
      { instrumentId: "SZSE:000001", quantity: 50, averageCost: 20 },
    ],
    cash: 500,
    rulesVersion: "risk-rules.v1.2",
    ...overrides,
  };
}

test("portfolio snapshot schema is exact, bounded by TTL, and fingerprints canonical fields", async () => {
  const accepted = normalizePortfolioSnapshotUpload(upload(), NOW);
  assert.deepEqual(accepted.issues, []);
  assert.ok(accepted.snapshot);
  assert.deepEqual(
    Object.keys(accepted.snapshot).sort(),
    [
      "calculatedAt",
      "cash",
      "effectiveAt",
      "expiresAt",
      "positions",
      "rulesVersion",
      "schemaVersion",
      "sourceRevision",
    ],
  );

  const extraField = normalizePortfolioSnapshotUpload(
    { ...upload(), accountName: "must-not-cross-boundary" },
    NOW,
  );
  assert.equal(extraField.snapshot, null);
  assert.match(extraField.issues.join("\n"), /accountName is not allowed/);

  const tooLong = normalizePortfolioSnapshotUpload(
    upload({
      expiresAt: new Date(
        Date.parse("2026-08-07T08:00:00.000Z") + PORTFOLIO_SNAPSHOT_MAX_TTL_MS + 1,
      ).toISOString(),
    }),
    NOW,
  );
  assert.equal(tooLong.snapshot, null);
  assert.match(tooLong.issues.join("\n"), /allowed snapshot lifetime/);

  const first = await calculatePortfolioSnapshotFingerprint(upload());
  const reordered = await calculatePortfolioSnapshotFingerprint(
    upload({ positions: [...upload().positions].reverse() }),
  );
  const changed = await calculatePortfolioSnapshotFingerprint(upload({ cash: 501 }));
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("portfolio history purge remains profile-scoped and cascades associated run records", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const batches: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          statements.push({ sql, values });
          return {
            async all() {
              if (sql.includes("SELECT id, fingerprint FROM portfolio_snapshots")) {
                return {
                  results: [
                    { id: "snapshot-a", fingerprint: "sha256:a" },
                    { id: "snapshot-b", fingerprint: "sha256:b" },
                  ],
                };
              }
              if (sql.includes("GROUP BY portfolio_snapshot_id")) {
                return {
                  results: [
                    { portfolio_snapshot_id: "snapshot-a", count: 2 },
                    { portfolio_snapshot_id: "snapshot-b", count: 1 },
                  ],
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(batch: unknown[]) {
      batches.push(batch);
      return [];
    },
  } as unknown as D1Database;

  const result = await new D1PortfolioSnapshotRepository(db).purgeHistory(
    "profile-owner",
    "expired",
    "2026-08-07T08:00:00.000Z",
  );

  assert.deepEqual(result, { snapshots: 2, runs: 3 });
  assert.equal(batches.length, 1);
  assert.ok(
    statements.some((statement) =>
      statement.sql.includes("INSERT INTO portfolio_purge_tombstones"),
    ),
  );
  const cascades = statements.filter((statement) =>
    /DELETE FROM (agent_feedback|market_events|run_market_events|run_market_snapshots|run_dispatch_outbox|dead_letter_records|agent_runs)/.test(statement.sql),
  );
  assert.equal(cascades.length, 7);
  for (const statement of cascades) {
    assert.match(statement.sql, /agent_runs WHERE profile_id = \?/);
    assert.ok(statement.values.includes("profile-owner"));
    assert.equal(statement.values.includes("profile-other"), false);
  }
});

test("only fresh, non-stopped snapshots are eligible for a future run", async () => {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() {
          return { async first() { return null; } };
        },
      };
    },
  } as unknown as D1Database;
  const repository = new D1PortfolioSnapshotRepository(db);
  const now = "2026-08-07T08:00:00.000Z";

  await repository.getCurrent("profile-owner", now);
  await repository.getUsableForProfile("profile-owner", "snapshot-a", now);

  for (const statement of statements) {
    assert.match(statement, /stopped_at IS NULL/);
    assert.match(statement, /expires_at > \?/);
  }
});
