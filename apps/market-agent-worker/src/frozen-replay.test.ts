import assert from "node:assert/strict";
import test from "node:test";
import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { evaluateFrozenRun } from "./frozen-replay.ts";
import { createRunCheckpoint } from "./run-checkpoint.ts";

const previous = snapshot("2026-08-13T07:00:00.000Z", 10);
const current = snapshot("2026-08-14T07:00:00.000Z", 11);
const evidence: SealedEvidenceBundle = {
  schemaVersion: "market-agent.v1",
  eventRuleVersion: "market-event.v1",
  profileId: "profile-1",
  workflow: "close_review",
  watchlistRevision: "w1",
  instrumentIds: ["SSE:600000"],
  items: [{
    id: "run-1:snapshot-diff",
    kind: "snapshot_diff",
    origin: "server-observed",
    reliable: true,
    value: {
      previousAsOf: previous.asOf,
      currentAsOf: current.asOf,
      changes: [{ kind: "quote_price", instrumentId: "SSE:600000", previous: 10, current: 11, delta: 1, deltaBps: 1000 }],
    },
  }],
  contextUses: [],
  fingerprint: "sha256:frozen-fixture",
  sealedAt: "2026-08-14T07:00:02.000Z",
};

test("frozen replay independently verifies scope, fingerprint and point-in-time diff", async () => {
  const result = await evaluateFrozenRun({
    checkpoint: await createRunCheckpoint(current, evidence),
    previous,
    expected: { profileId: "profile-1", workflow: "close_review", evidenceFingerprint: "sha256:frozen-fixture" },
  });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test("frozen replay rejects a changed Evidence diff instead of silently accepting new Market Facts", async () => {
  const checkpoint = await createRunCheckpoint(current, evidence);
  const tampered: SealedEvidenceBundle = structuredClone(evidence);
  (tampered.items[0].value as { changes: Array<{ current: number }> }).changes[0].current = 12;
  const result = await evaluateFrozenRun({
    checkpoint: { ...checkpoint, evidence: tampered },
    previous,
    expected: { profileId: "profile-1", workflow: "close_review", evidenceFingerprint: "sha256:frozen-fixture" },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, ["CHECKPOINT_INTEGRITY_MISMATCH", "SNAPSHOT_DIFF_MISMATCH"]);
});

test("frozen replay refuses a stored diff without its previous frozen Snapshot", async () => {
  const result = await evaluateFrozenRun({
    checkpoint: await createRunCheckpoint(current, evidence),
    expected: { profileId: "profile-1", workflow: "close_review", evidenceFingerprint: "sha256:frozen-fixture" },
  });
  assert.deepEqual(result.issues, ["PREVIOUS_SNAPSHOT_REQUIRED"]);
});

test("frozen replay verifies an expected Ask scope", async () => {
  const askEvidence: SealedEvidenceBundle = { ...evidence, workflow: "ask", ask: { scope: "today_change", planVersion: "ask-plan.v1" } };
  const result = await evaluateFrozenRun({
    checkpoint: await createRunCheckpoint(current, askEvidence),
    previous,
    expected: { profileId: "profile-1", workflow: "ask", askScope: "relative_performance", evidenceFingerprint: "sha256:frozen-fixture" },
  });
  assert.ok(result.issues.includes("ASK_SCOPE_MISMATCH"));
});

function snapshot(asOf: string, price: number): MarketSnapshot {
  return {
    schemaVersion: "market-snapshot.v1",
    asOf,
    receivedAt: asOf,
    marketTimestamp: asOf,
    request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" },
    data: { quotes: [{ instrumentId: "SSE:600000", price, previousClose: 10, open: 10, high: price, low: 10, volume: 100, turnover: 1000, marketTimestamp: asOf, receivedAt: asOf, source: "frozen-fixture", quality: "live", stale: false, warnings: [], corroboration: { mode: "corroborated", status: "corroborated", thresholdBps: 50, maxDeviationBps: 0, observations: [{ provider: "fixture-a", price, marketTimestamp: asOf, receivedAt: asOf }, { provider: "fixture-b", price, marketTimestamp: asOf, receivedAt: asOf }] } }], bars: [], news: [], announcements: [], status: [] },
    capabilities: [{ id: "quotes", status: "operational", required: true, asOf, receivedAt: asOf, freshness: "fresh", warnings: [], attempts: [] }],
    quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] },
  };
}
