import assert from "node:assert/strict";
import test from "node:test";
import { D1RunRepository } from "./d1-repository.ts";
import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { checkpointSnapshotPayload, createRunCheckpoint } from "./run-checkpoint.ts";
import { calculateResearchFactBundleFingerprint } from "@zxlab/research-fact-schema";
import { researchFactBundleFixture } from "@zxlab/research-fact-schema/fixtures";

test("run deletion scopes every evidence-related delete to the owning profile", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          statements.push({ sql, values });
          return {};
        },
      };
    },
    async batch() {
      return [{}, {}, {}, {}, {}, { meta: { changes: 1 } }];
    },
  } as unknown as D1Database;
  const deleted = await new D1RunRepository(db).delete("run-1", "profile-owner");
  assert.equal(deleted, true);
  for (const statement of statements.slice(1)) {
    assert.match(statement.sql, /profile_id = \?/);
    assert.ok(statement.values.includes("profile-owner"));
  }
});

test("schedule decisions never create an Agent Run", async () => {
  let statement = "";
  const db = { prepare(sql: string) { statement = sql; return { bind() { return { async run() { return {}; } }; } }; } } as unknown as D1Database;
  await new D1RunRepository(db).recordScheduleDecision({ workflow: "morning_brief", marketDate: "2026-10-05", decision: "skipped", calendarSource: "official", reason: "MARKET_CLOSED" });
  assert.match(statement, /INSERT INTO agent_schedule_decisions/);
  assert.doesNotMatch(statement, /agent_runs/);
});

test("Evidence lookup remains terminal and profile-scoped", async () => {
  let statement = "";
  const db = {
    prepare(sql: string) {
      statement = sql;
      return {
        bind() {
          return {
            async first() {
              return {
                evidence_json: JSON.stringify({
                  schemaVersion: "market-agent.v1",
                  eventRuleVersion: "market-event.v1",
                  profileId: "profile-owner",
                  workflow: "close_review",
                  watchlistRevision: "w1",
                  instrumentIds: [],
                  items: [],
                  contextUses: [],
                  fingerprint: "sha256:evidence",
                  sealedAt: "2026-08-07T00:00:00.000Z",
                }),
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const evidence = await new D1RunRepository(db).getEvidence("run-1", "profile-owner");
  assert.equal(evidence?.fingerprint, "sha256:evidence");
  assert.match(statement, /profile_id = \?/);
  assert.match(statement, /status IN \('success', 'partial'\)/);
});

test("checkpoint lookup returns the frozen Market Snapshot and Evidence Bundle for the owning profile", async () => {
  let statement = "";
  const snapshot = checkpointSnapshot();
  const evidence = checkpointEvidence();
  const expectedCheckpoint = await createRunCheckpoint(snapshot, evidence);
  const db = {
    prepare(sql: string) {
      statement = sql;
      return {
        bind() {
          return {
            async first() {
              return { snapshot_json: JSON.stringify(snapshot), evidence_json: JSON.stringify(evidence), fingerprint: expectedCheckpoint.integrityFingerprint };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  const checkpoint = await new D1RunRepository(db).getCheckpoint("run-1", "profile-owner");

  assert.deepEqual(checkpoint, expectedCheckpoint);
  assert.match(statement, /profile_id = \?/);
  assert.match(statement, /run_market_snapshots/);
});

test("previous checkpoint lookup returns the latest terminal Run from the same profile and workflow", async () => {
  let statement = "";
  const snapshot = checkpointSnapshot();
  const evidence = checkpointEvidence();
  const expectedCheckpoint = await createRunCheckpoint(snapshot, evidence);
  const db = {
    prepare(sql: string) {
      statement = sql;
      return { bind() { return { async first() { return { snapshot_json: JSON.stringify(snapshot), evidence_json: JSON.stringify(evidence), fingerprint: expectedCheckpoint.integrityFingerprint }; } }; } };
    },
  } as unknown as D1Database;

  const checkpoint = await new D1RunRepository(db).getPreviousCheckpoint("run-current", "profile-owner");

  assert.deepEqual(checkpoint, expectedCheckpoint);
  assert.match(statement, /previous\.profile_id = current\.profile_id/);
  assert.match(statement, /previous\.workflow = current\.workflow/);
  assert.match(statement, /ORDER BY previous\.created_at DESC/);
});

test("checkpoint lookup restores the frozen Research Facts from the versioned snapshot payload", async () => {
  const snapshot = checkpointSnapshot();
  const evidence = checkpointEvidence();
  const research = researchFactBundleFixture();
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  const expectedCheckpoint = await createRunCheckpoint(snapshot, evidence, research);
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return {
                snapshot_json: JSON.stringify(checkpointSnapshotPayload(expectedCheckpoint)),
                evidence_json: JSON.stringify(evidence),
                fingerprint: expectedCheckpoint.integrityFingerprint,
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  const checkpoint = await new D1RunRepository(db).getCheckpoint("run-1", "profile-owner");

  assert.deepEqual(checkpoint, expectedCheckpoint);
});

test("an existing invalid sealed checkpoint is not treated as absent", async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return { snapshot_json: "{invalid", evidence_json: JSON.stringify(checkpointEvidence()), fingerprint: `sha256:${"0".repeat(64)}` };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  await assert.rejects(new D1RunRepository(db).getCheckpoint("run-1", "profile-owner"), /RUN_CHECKPOINT_INVALID/);
});

test("checkpoint write reports a lost lease instead of claiming sealed state", async () => {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) { statements.push(sql); return { bind() { return {}; } }; },
    async batch() { return [{ meta: { changes: 0 } }, {}, {}]; },
  } as unknown as D1Database;

  const checkpoint = await createRunCheckpoint(checkpointSnapshot(), checkpointEvidence());
  const stored = await new D1RunRepository(db).checkpoint(
    "run-1",
    "profile-owner",
    "stale-lease",
    checkpoint,
  );

  assert.equal(stored, false);
  assert.match(statements[0] ?? "", /NOT EXISTS \(SELECT 1 FROM run_market_snapshots/);
  assert.match(statements[1] ?? "", /ON CONFLICT\(run_id\) DO NOTHING/);
  assert.equal(statements.some((sql) => sql.startsWith("DELETE FROM run_market")), false);
});

test("quality metrics separate model completion from deterministic fallback", async () => {
  const resultRows = [
    {
      result_json: JSON.stringify({
        status: "success", headline: "model", summary: "model", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: "sha256:model", mode: "market-only",
        outcome: { execution: "completed", narration: { source: "model" }, evidence: { coverage: "sufficient", delivery: "fallback", fallbackCapabilities: ["announcements:SSE:600000"], limitations: [] }, mode: "market-only" },
      }),
    },
    {
      result_json: JSON.stringify({ status: "partial", headline: "fallback", summary: "fallback", observations: [], portfolioImpacts: [], watchNext: [], limitations: ["Gateway 暂不可用，已降级为确定性结果。"], evidenceFingerprint: "sha256:fallback", mode: "market-only" }),
    },
  ];
  let boundValues: unknown[] = [];
  const scopedDb = {
    prepare(sql: string) {
      assert.match(sql, /profile_id = \?/);
      return { bind(...values: unknown[]) { boundValues = values; return { async all() { return { results: resultRows }; } }; } };
    },
  } as unknown as D1Database;

  const metrics = await new D1RunRepository(scopedDb).qualityMetrics("profile-owner");

  assert.deepEqual(metrics, { total: 2, completed: 2, model: 1, modelRepaired: 0, deterministicFallback: 1, evidenceSufficient: 2, providerFallback: 1, portfolioAware: 0 });
  assert.deepEqual(boundValues, ["profile-owner", 50]);
});

function checkpointSnapshot(): MarketSnapshot {
  return {
    schemaVersion: "market-snapshot.v1",
    asOf: "2026-08-14T00:00:00.000Z",
    receivedAt: "2026-08-14T00:00:01.000Z",
    marketTimestamp: null,
    request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" },
    data: { quotes: [], bars: [], news: [], announcements: [], status: [] },
    capabilities: [{ id: "quotes", status: "unavailable", required: true, asOf: null, receivedAt: "2026-08-14T00:00:01.000Z", freshness: "unknown", warnings: ["fixture unavailable"], attempts: [] }],
    quality: { status: "unavailable", reliable: false, freshness: "unknown", warnings: ["fixture unavailable"], attempts: [], unavailableCapabilities: ["quotes"] },
  };
}

function checkpointEvidence(): SealedEvidenceBundle {
  return {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "profile-owner",
    workflow: "close_review",
    watchlistRevision: "w1",
    instrumentIds: ["SSE:600000"],
    items: [],
    contextUses: [],
    fingerprint: "sha256:checkpoint",
    sealedAt: "2026-08-14T00:00:02.000Z",
  };
}
