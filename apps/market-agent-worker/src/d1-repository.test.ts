import assert from "node:assert/strict";
import test from "node:test";
import { D1RunRepository } from "./d1-repository.ts";

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
  const db = {
    prepare() {
      return { bind() { return { async all() { return { results: resultRows }; } }; } };
    },
  } as unknown as D1Database;

  const metrics = await new D1RunRepository(db).qualityMetrics();

  assert.deepEqual(metrics, { total: 2, completed: 2, model: 1, modelRepaired: 0, deterministicFallback: 1, evidenceSufficient: 2, providerFallback: 1, portfolioAware: 0 });
});
