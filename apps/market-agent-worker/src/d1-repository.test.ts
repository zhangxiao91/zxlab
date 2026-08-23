import assert from "node:assert/strict";
import test from "node:test";
import { applyRunFeedback, D1RunRepository } from "./d1-repository.ts";
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
      return [{}, {}, {}, {}, {}, {}, {}, { meta: { changes: 1 } }];
    },
  } as unknown as D1Database;
  const deleted = await new D1RunRepository(db).delete("run-1", "profile-owner");
  assert.equal(deleted, true);
  for (const statement of statements.slice(1)) {
    assert.match(statement.sql, /profile_id = \?/);
    assert.ok(statement.values.includes("profile-owner"));
  }
  assert.ok(statements.some((statement) => statement.sql.includes("DELETE FROM financial_tool_trace_events")));
  assert.ok(statements.some((statement) => statement.sql.includes("DELETE FROM financial_tool_invocations")));
});

test("schedule decisions never create an Agent Run", async () => {
  let statement = "";
  const db = { prepare(sql: string) { statement = sql; return { bind() { return { async run() { return {}; } }; } }; } } as unknown as D1Database;
  await new D1RunRepository(db).recordScheduleDecision({ workflow: "morning_brief", marketDate: "2026-10-05", decision: "skipped", calendarSource: "official", reason: "MARKET_CLOSED" });
  assert.match(statement, /INSERT INTO agent_schedule_decisions/);
  assert.doesNotMatch(statement, /agent_runs/);
});

test("feedback upsert returns the persisted profile-scoped resource", async () => {
  let statement = "";
  let boundValues: unknown[] = [];
  const db = {
    prepare(sql: string) {
      statement = sql;
      return {
        bind(...values: unknown[]) {
          boundValues = values;
          return { async run() { return { meta: { changes: 1 } }; } };
        },
      };
    },
  } as unknown as D1Database;

  const feedback = await new D1RunRepository(db).recordFeedback(
    "run-1",
    "profile-owner",
    "missing_factor",
    "2026-08-15T01:02:03.000Z",
  );

  assert.deepEqual(feedback, {
    value: "missing_factor",
    updatedAt: "2026-08-15T01:02:03.000Z",
  });
  assert.match(statement, /ON CONFLICT\(run_id, profile_id\)/);
  assert.deepEqual(boundValues.slice(1), [
    "run-1",
    "profile-owner",
    "missing_factor",
    "2026-08-15T01:02:03.000Z",
  ]);
});

test("feedback application validates values and hides cross-profile runs", async () => {
  const rows = new Map([
    ["run-owner", runRepositoryRow("run-owner", "profile-owner")],
    ["run-private", runRepositoryRow("run-private", "profile-other")],
  ]);
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              return sql === "SELECT * FROM agent_runs WHERE id = ?"
                ? rows.get(String(values[0])) ?? null
                : null;
            },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  } as unknown as D1Database;
  const repository = new D1RunRepository(db);

  const saved = await applyRunFeedback(repository, "run-owner", "profile-owner", "helpful");
  const invalid = await applyRunFeedback(repository, "run-owner", "profile-owner", "liked");
  const crossProfile = await applyRunFeedback(repository, "run-private", "profile-owner", "helpful");

  assert.equal(saved.kind, "saved");
  assert.equal(saved.kind === "saved" ? saved.feedback.value : null, "helpful");
  assert.deepEqual(invalid, { kind: "invalid" });
  assert.deepEqual(crossProfile, { kind: "not_found" });
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
    async batch() { return [{}, { meta: { changes: 0 } }, {}, {}]; },
  } as unknown as D1Database;

  const checkpoint = await createRunCheckpoint(checkpointSnapshot(), checkpointEvidence());
  const stored = await new D1RunRepository(db).checkpoint(
    "run-1",
    "profile-owner",
    "stale-lease",
    checkpoint,
  );

  assert.equal(stored, false);
  assert.ok(statements.some((sql) => /NOT EXISTS \(SELECT 1 FROM run_market_snapshots/.test(sql)));
  assert.ok(statements.some((sql) => /ON CONFLICT\(run_id\) DO NOTHING/.test(sql)));
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

test("Run trace is profile-scoped, sequence ordered, and exposes server timing", async () => {
  const run = {
    ...runRepositoryRow("run-trace", "profile-owner"),
    status: "success",
    created_at: "2026-08-15T00:00:00.000Z",
    started_at: "2026-08-15T00:00:01.000Z",
    updated_at: "2026-08-15T00:00:04.000Z",
    completed_at: "2026-08-15T00:00:04.000Z",
    duration_ms: 4000,
  };
  const traceRows = [
    traceRow(7, "stage_started", "collecting", "2026-08-15T00:00:01.000Z", "run.claim"),
    traceRow(9, "run_completed", "success", "2026-08-15T00:00:04.000Z", "run.complete", 4000),
  ];
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() {
          return {
            async first() { return sql.includes("FROM agent_runs") ? run : null; },
            async all() { return { results: traceRows }; },
          };
        },
      };
    },
  } as unknown as D1Database;

  const trace = await new D1RunRepository(db).getTrace(
    "run-trace",
    "profile-owner",
    "2026-08-15T00:00:05.000Z",
  );

  assert.equal(trace?.runId, "run-trace");
  assert.deepEqual(trace?.events.map((event) => event.sequence), [7, 9]);
  assert.equal(trace?.events[1]?.durationMs, 4000);
  assert.deepEqual(trace?.timing, {
    queuedAt: "2026-08-15T00:00:00.000Z",
    startedAt: "2026-08-15T00:00:01.000Z",
    updatedAt: "2026-08-15T00:00:04.000Z",
    completedAt: "2026-08-15T00:00:04.000Z",
    elapsedMs: 3000,
    durationMs: 4000,
    serverNow: "2026-08-15T00:00:05.000Z",
  });
  assert.ok(statements.every((sql) => !sql.includes("run_trace_events") || sql.includes("profile_id = ?")));
});

test("Run trace fails closed when a persisted event is invalid", async () => {
  const run = runRepositoryRow("run-trace", "profile-owner");
  const corrupt = { ...traceRow(1, "stage_started", "collecting", "2026-08-15T00:00:01.000Z", "run.claim"), source: "untrusted-source" };
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() { return sql.includes("FROM agent_runs") ? run : null; },
            async all() { return { results: [corrupt] }; },
          };
        },
      };
    },
  } as unknown as D1Database;

  await assert.rejects(
    new D1RunRepository(db).getTrace("run-trace", "profile-owner"),
    /RUN_TRACE_CORRUPT/,
  );
});

test("cancelling an active Run is durable, idempotent, and fences its old lease", async () => {
  const row: Record<string, unknown> = {
    ...runRepositoryRow("run-cancel", "profile-owner"),
    status: "generating",
    lease_token: "old-lease",
    started_at: "2026-08-15T00:00:01.000Z",
    updated_at: "2026-08-15T00:00:02.000Z",
    completed_at: null,
    duration_ms: null,
  };
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(...values: unknown[]) {
          return {
            async first() { return sql.includes("FROM agent_runs") ? row : null; },
            async run() {
              if (sql.startsWith("UPDATE agent_runs SET status = 'cancelled'")) {
                if (row.status === "cancelled") return { meta: { changes: 0 } };
                row.status = "cancelled";
                row.lease_token = null;
                row.updated_at = String(values[0]);
                row.completed_at = String(values[0]);
                row.duration_ms = 4000;
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith("UPDATE agent_runs SET status = ?")) return { meta: { changes: 0 } };
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(items: Array<{ run?: () => Promise<unknown> }>) {
      return Promise.all(items.map((item) => item.run?.() ?? {}));
    },
  } as unknown as D1Database;
  const repository = new D1RunRepository(db);

  const first = await repository.cancel("run-cancel", "profile-owner", "2026-08-15T00:00:04.000Z");
  const second = await repository.cancel("run-cancel", "profile-owner", "2026-08-15T00:00:05.000Z");
  const staleCompletion = await repository.complete("run-cancel", "old-lease", checkpointEvidence(), {
    status: "success",
    headline: "stale",
    summary: "stale",
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: "sha256:evidence",
    mode: "market-only",
  });

  assert.equal(first.kind, "cancelled");
  assert.equal(first.kind === "cancelled" ? first.run.status : null, "cancelled");
  assert.equal(second.kind, "already_cancelled");
  assert.equal(staleCompletion, false);
  assert.ok(statements.some((sql) => sql.includes("lease_token = NULL") && sql.includes("lease_expires_at = NULL")));
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

function runRepositoryRow(id: string, profileId: string): Record<string, unknown> {
  return {
    id,
    profile_id: profileId,
    workflow: "close_review",
    trigger: "manual",
    status: "success",
    idempotency_key: `key-${id}`,
    command_hash: `sha256:${id}`,
    revision_of_run_id: null,
    portfolio_snapshot_id: null,
    attempt: 1,
    recovery_generation: 0,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    evidence_fingerprint: null,
    failure_json: null,
  };
}

function traceRow(
  sequence: number,
  type: string,
  stage: string,
  occurredAt: string,
  operation: string,
  durationMs: number | null = null,
): Record<string, unknown> {
  return {
    sequence,
    id: `trace-${sequence}`,
    run_id: "run-trace",
    profile_id: "profile-owner",
    type,
    stage,
    attempt: 1,
    recovery_generation: 0,
    occurred_at: occurredAt,
    duration_ms: durationMs,
    source: "market-agent-worker",
    operation,
    code: null,
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
