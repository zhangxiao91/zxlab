import assert from "node:assert/strict";
import test from "node:test";
import { validateBrowserRunIntent } from "@zxlab/market-agent-schema";
import { buildDeterministicCloseReview, MemoryRunRepository } from "./foundation.ts";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { createRunCheckpoint } from "./run-checkpoint.ts";

test("browser intent cannot select profile or trigger", () => assert.ok(validateBrowserRunIntent({ workflow: "close_review", idempotencyKey: "request-123", profileId: "forged" }).includes("profileId and trigger are server-only")));
test("run creation is idempotent and rejects hash reuse", async () => {
  const repo = new MemoryRunRepository();
  const command = { workflow: "close_review" as const, idempotencyKey: "request-123", profileId: "p1", trigger: "manual" as const };
  const first = await repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:a" });
  const second = await repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:a" });
  assert.equal(first.run.id, second.run.id); assert.equal(second.created, false);
  await assert.rejects(() => repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:b" }), /IDEMPOTENCY_KEY_REUSED/);
});

test("a claimed Agent Run checkpoints and rereads the same sealed state through the repository interface", async () => {
  const repo = new MemoryRunRepository();
  const command = { workflow: "close_review" as const, idempotencyKey: "checkpoint-123", profileId: "p1", trigger: "manual" as const };
  const created = await repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:checkpoint" });
  const claim = await repo.claim(created.run.id, "worker-1", "2026-08-14T00:00:00.000Z", "2026-08-14T00:04:00.000Z");
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  const snapshot: MarketSnapshot = {
    schemaVersion: "market-snapshot.v1",
    asOf: "2026-08-14T00:00:00.000Z",
    receivedAt: "2026-08-14T00:00:01.000Z",
    marketTimestamp: null,
    request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" },
    data: { quotes: [], bars: [], news: [], announcements: [], status: [] },
    capabilities: [{ id: "quotes", status: "unavailable", required: true, asOf: null, receivedAt: "2026-08-14T00:00:01.000Z", freshness: "unknown", warnings: ["fixture unavailable"], attempts: [] }],
    quality: { status: "unavailable", reliable: false, freshness: "unknown", warnings: ["fixture unavailable"], attempts: [], unavailableCapabilities: ["quotes"] },
  };
  const evidence = {
    schemaVersion: "market-agent.v1" as const,
    eventRuleVersion: "market-event.v1" as const,
    profileId: "p1",
    workflow: "close_review" as const,
    watchlistRevision: "w1",
    instrumentIds: ["SSE:600000"],
    items: [],
    contextUses: [],
    fingerprint: "sha256:checkpoint" as const,
    sealedAt: "2026-08-14T00:00:02.000Z",
  };

  const checkpoint = await createRunCheckpoint(snapshot, evidence);
  assert.equal(await repo.checkpoint(created.run.id, "p1", claim.lease.leaseToken, checkpoint), true);
  assert.deepEqual(await repo.getCheckpoint(created.run.id, "p1"), checkpoint);
  assert.equal(await repo.getCheckpoint(created.run.id, "another-profile"), null);
});

test("seals the authoritative market reference inside snapshot context", async () => {
  const reference = { requestedCalendarDate: "2026-08-16", effectiveTradingDate: "2026-08-14", session: "holiday" as const, semantics: "last_effective_session" as const };
  const snapshot: MarketSnapshot = {
    schemaVersion: "market-snapshot.v1",
    asOf: "2026-08-16T07:52:55.693Z",
    receivedAt: "2026-08-16T07:52:55.693Z",
    marketTimestamp: "2026-08-14T07:00:00.000Z",
    reference,
    request: { instrumentIds: ["SSE:600000"], intervals: ["1d", "1m"], include: ["quotes", "bars"], quoteMode: "corroborated" },
    data: { quotes: [], bars: [], news: [], announcements: [], status: [] },
    capabilities: [],
    quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] },
  };
  const evidence = await buildDeterministicCloseReview(
    { workflow: "close_review", idempotencyKey: "weekend-reference", profileId: "p1", trigger: "manual" },
    snapshot,
    [],
    "weekend-run",
  );
  const context = evidence.items.find((item) => (item.value as { type?: string }).type === "snapshot_context");

  assert.deepEqual((context?.value as { reference?: unknown }).reference, reference);
});
