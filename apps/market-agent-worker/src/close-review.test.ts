import assert from "node:assert/strict";
import test from "node:test";
import { CloseReviewService } from "./close-review.ts";
import type { PortfolioSnapshot } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { calculateResearchFactBundleFingerprint } from "@zxlab/research-fact-schema";
import { researchFactBundleFixture } from "@zxlab/research-fact-schema/fixtures";
import { canonicalMemoryRevisionHash } from "./confirmed-context.ts";
import { createRunCheckpoint } from "./run-checkpoint.ts";

const snapshot: MarketSnapshot = { schemaVersion: "market-snapshot.v1", asOf: "2026-08-05T08:00:00.000Z", receivedAt: "2026-08-05T08:00:01.000Z", marketTimestamp: "2026-08-05T07:59:00.000Z", request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" }, data: { quotes: [{ instrumentId: "SSE:600000", price: 12, previousClose: 10, open: 10, high: 12, low: 10, volume: 100, turnover: 1200, marketTimestamp: "2026-08-05T07:59:00.000Z", receivedAt: "2026-08-05T08:00:01.000Z", source: "fixture", quality: "live", stale: false, warnings: [], corroboration: { mode: "corroborated", status: "corroborated", thresholdBps: 50, maxDeviationBps: 10, observations: [] } }], bars: [], news: [], announcements: [], status: [] }, capabilities: [], quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] } };

function weekendSnapshot(asOf: string): MarketSnapshot {
  return {
    ...snapshot,
    asOf,
    receivedAt: asOf,
    marketTimestamp: "2026-08-14T07:00:00.000Z",
    reference: {
      requestedCalendarDate: "2026-08-16",
      effectiveTradingDate: "2026-08-14",
      session: "holiday",
      semantics: "last_effective_session",
    },
    quality: { ...snapshot.quality, status: "operational", reliable: true, freshness: "fresh" },
  };
}

async function laggedPriceContextResearch() {
  const research = researchFactBundleFixture();
  research.purpose = "price_context";
  research.planVersion = "price-context.v1";
  research.expectedLatestSessionDate = "2026-08-14";
  const baseline = research.capabilities.find((capability) => capability.id === "market_baselines")!;
  baseline.status = "degraded";
  baseline.asOf = "2026-08-13T07:00:00.000Z";
  baseline.warnings = ["LATEST_SESSION_MISSING"];
  baseline.limitations = [{
    code: "LATEST_SESSION_MISSING",
    retryable: false,
    expectedSessionDate: "2026-08-14",
    actualSessionDate: "2026-08-13",
  }];
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  return research;
}

test("close review seals evidence before narration", async () => {
  const service = new CloseReviewService({ getCurrentSnapshot: async () => snapshot });
  const result = await service.execute({ runId: "run-1", command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-1" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });
  const eventEvidence = result.evidence.items.find((item) => item.kind === "market_event");
  assert.equal(result.result.mode, "market-only");
  assert.ok(eventEvidence);
  assert.ok(result.result.observations.some((item) => item.evidenceIds.includes(eventEvidence.id)));
});

test("weekend close review propagates the effective session and keeps a Research-only lag separate from Market freshness", async () => {
  const research = await laggedPriceContextResearch();
  let researchRequest: Parameters<NonNullable<ConstructorParameters<typeof CloseReviewService>[3]>["materialize"]>[0] | undefined;
  const service = new CloseReviewService(
    { getCurrentSnapshot: async () => weekendSnapshot(research.observationCutoff) },
    undefined,
    undefined,
    { async materialize(input) { researchRequest = input; return research; } },
  );

  const output = await service.execute({
    runId: "close-weekend-research-lag",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-weekend-research-lag" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
  });

  assert.deepEqual(researchRequest, {
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: research.observationCutoff,
    expectedLatestSessionDate: "2026-08-14",
  });
  assert.equal(output.result.status, "partial");
  assert.equal(output.result.outcome?.evidence.coverage, "limited");
  const limitation = output.result.outcome?.evidence.limitations.find((item) => item.code === "LATEST_SESSION_MISSING");
  assert.equal(limitation?.capability, "research:market_baselines");
  assert.match(limitation?.message ?? "", /expected=2026-08-14/);
  assert.match(limitation?.message ?? "", /actual=2026-08-13/);
  assert.equal(output.result.outcome?.evidence.limitations.some((item) => item.code === "MARKET_SNAPSHOT_UNRELIABLE"), false);
  const snapshotContext = output.evidence.items.find((item) => (item.value as { type?: unknown })?.type === "snapshot_context");
  assert.equal((snapshotContext?.value as { quality?: { reliable?: unknown; freshness?: unknown } }).quality?.reliable, true);
  assert.equal((snapshotContext?.value as { quality?: { reliable?: unknown; freshness?: unknown } }).quality?.freshness, "fresh");
});

test("close review does not impose a completed-session baseline date during a live session", async () => {
  const research = researchFactBundleFixture();
  research.purpose = "price_context";
  research.planVersion = "price-context.v1";
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  let researchRequest: Parameters<NonNullable<ConstructorParameters<typeof CloseReviewService>[3]>["materialize"]>[0] | undefined;
  const service = new CloseReviewService(
    { getCurrentSnapshot: async () => ({
      ...snapshot,
      asOf: research.observationCutoff,
      reference: { requestedCalendarDate: "2026-08-14", effectiveTradingDate: "2026-08-14", session: "open", semantics: "live_session" },
    }) },
    undefined,
    undefined,
    { async materialize(input) { researchRequest = input; return research; } },
  );

  await service.execute({
    runId: "close-live-research",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-live-research" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
  });

  assert.equal(Object.hasOwn(researchRequest ?? {}, "expectedLatestSessionDate"), false);
});

test("close review resumes the same sealed Evidence Bundle without recollecting Market Facts", async () => {
  let checkpoint: Parameters<CloseReviewService["execute"]>[0]["checkpoint"];
  const first = await new CloseReviewService({ getCurrentSnapshot: async () => snapshot }).execute({
    runId: "run-checkpoint",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-checkpoint" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
    onCheckpoint: async (value) => { checkpoint = value; },
  });
  assert.ok(checkpoint);

  const resumed = await new CloseReviewService({
    getCurrentSnapshot: async () => { throw new Error("Market Facts must not be recollected after evidence_sealed"); },
  }, undefined, {
    retrieve: async () => { throw new Error("Signal Memory must not be reread after evidence_sealed"); },
  }).execute({
    runId: "run-checkpoint",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-checkpoint" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
    checkpoint,
  });

  assert.equal(resumed.evidence.fingerprint, first.evidence.fingerprint);
  assert.equal(resumed.evidence.sealedAt, first.evidence.sealedAt);
});

test("close review seals price-context Research Facts and does not recollect them after checkpoint", async () => {
  const research = researchFactBundleFixture();
  research.purpose = "price_context";
  research.planVersion = "price-context.v1";
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  let researchCalls = 0;
  let checkpoint: Parameters<CloseReviewService["execute"]>[0]["checkpoint"];
  const first = await new CloseReviewService(
    { getCurrentSnapshot: async () => ({ ...snapshot, asOf: research.observationCutoff }) },
    undefined,
    undefined,
    {
      async materialize(input) {
        researchCalls += 1;
        assert.deepEqual(input, {
          purpose: "price_context",
          instrumentIds: ["SSE:600000"],
          observationCutoff: research.observationCutoff,
        });
        return research;
      },
    },
  ).execute({
    runId: "run-research-checkpoint",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-research" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
    onCheckpoint: async (value) => { checkpoint = value; },
  });

  assert.equal(researchCalls, 1);
  assert.equal(checkpoint?.research?.fingerprint, research.fingerprint);
  assert.equal(first.evidence.items.filter((item) => (item.value as { type?: unknown })?.type === "research_fact").length, research.facts.length);
  checkpoint = await createRunCheckpoint(checkpoint!.snapshot, {
    ...checkpoint!.evidence,
    items: [...checkpoint!.evidence.items, {
      id: "run-research-checkpoint:research:limitation:scope",
      kind: "limitation",
      origin: "server-observed",
      reliable: true,
      value: { type: "research_scope", code: "RESEARCH_SCOPE_PARTIAL", includedInstrumentIds: ["SSE:600000"], omittedInstrumentIds: ["SSE:600001", "SSE:600002", "SSE:600003"] },
    }],
  }, checkpoint!.research);

  const resumed = await new CloseReviewService(
    { getCurrentSnapshot: async () => { throw new Error("Market Facts must not be recollected after evidence_sealed"); } },
    undefined,
    undefined,
    { materialize: async () => { throw new Error("Research Facts must not be recollected after evidence_sealed"); } },
  ).execute({
    runId: "run-research-checkpoint",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-research" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
    checkpoint,
  });

  assert.equal(resumed.evidence.fingerprint, first.evidence.fingerprint);
  assert.equal(researchCalls, 1);
  assert.match(resumed.result.outcome?.evidence.limitations.find((item) => item.code === "RESEARCH_SCOPE_PARTIAL")?.message ?? "", /另有 3 个标的/);
});

test("close review seals only context references while passing context ephemerally", async () => {
  const item = {
    memoryId: "memory-close",
    namespace: "markets" as const,
    kind: "preference" as const,
    content: "只关注有明确催化剂的市场变化。",
    importance: 0.8,
    confidence: 0.9,
    sourceType: "market-agent-preference",
    status: "active" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const revisionHash = await canonicalMemoryRevisionHash(item);
  const service = new CloseReviewService(
    { getCurrentSnapshot: async () => snapshot },
    undefined,
    { retrieve: async () => ({ contexts: [{ ...item, revisionHash, role: "preference" }], limitations: [] }) },
  );
  const result = await service.execute({ runId: "run-context", command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-context" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });
  assert.equal(result.evidence.contextUses.length, 1);
  assert.equal(result.evidence.contextUses[0]?.revisionHash, revisionHash);
  assert.doesNotMatch(JSON.stringify(result.evidence), /明确催化剂/);
});

test("morning brief keeps its workflow through sealed evidence and narration", async () => {
  const service = new CloseReviewService({ getCurrentSnapshot: async () => snapshot });
  const result = await service.execute({ runId: "run-morning", command: { profileId: "p1", trigger: "scheduled", workflow: "morning_brief", idempotencyKey: "morning-brief-1" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });
  assert.equal(result.evidence.workflow, "morning_brief");
  assert.match(result.result.headline, /盘前简报/);
});

test("close review seals a deterministic point-in-time diff against the prior frozen Market Snapshot", async () => {
  const previous: MarketSnapshot = {
    ...snapshot,
    asOf: "2026-08-04T08:00:00.000Z",
    receivedAt: "2026-08-04T08:00:01.000Z",
    data: {
      ...snapshot.data,
      quotes: snapshot.data.quotes.map((quote) => ({ ...quote, price: 11, receivedAt: "2026-08-04T08:00:01.000Z", marketTimestamp: "2026-08-04T07:59:00.000Z" })),
    },
  };
  const output = await new CloseReviewService({ getCurrentSnapshot: async () => snapshot }).execute({
    runId: "run-diff",
    command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-diff" },
    instrumentIds: ["SSE:600000"],
    watchlistRevision: "w1",
    previous,
  });

  const diff = output.evidence.items.find((item) => item.kind === "snapshot_diff");
  assert.ok(diff);
  assert.deepEqual((diff.value as { changes: unknown[] }).changes[0], {
    kind: "quote_price",
    instrumentId: "SSE:600000",
    previous: 11,
    current: 12,
    delta: 1,
    deltaBps: 909,
  });
});

test("a model-completed review stays successful when a usable provider fallback preserves evidence", async () => {
  const fallbackSnapshot: MarketSnapshot = {
    ...snapshot,
    capabilities: [{
      id: "announcements:SSE:600000",
      status: "degraded",
      required: true,
      asOf: null,
      receivedAt: snapshot.receivedAt,
      freshness: "fresh",
      warnings: [],
      attempts: [
        { provider: "cninfo-announcement", ok: false, latencyMs: 120, errorCode: "UPSTREAM_HTTP_ERROR", message: null },
        { provider: "eastmoney-announcement", ok: true, latencyMs: 90, errorCode: null, message: null },
      ],
    }],
    quality: { ...snapshot.quality, status: "degraded", reliable: true },
  };
  const service = new CloseReviewService(
    { getCurrentSnapshot: async () => fallbackSnapshot },
    { async narrate({ evidence }) { return { status: "partial", headline: "模型复盘完成", summary: "公告由备用来源提供。", observations: [], portfolioImpacts: [], watchNext: [], limitations: ["公告使用备用来源。"], evidenceFingerprint: evidence.fingerprint }; } },
  );

  const output = await service.execute({ runId: "run-fallback", command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-fallback" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });

  assert.equal(output.result.status, "success");
  assert.equal(output.result.outcome?.narration.source, "model");
  assert.equal(output.result.outcome?.evidence.coverage, "sufficient");
  assert.equal(output.result.outcome?.evidence.delivery, "fallback");
});

test("an expired portfolio snapshot stays out of the new evidence bundle", async () => {
  const portfolio: PortfolioSnapshot = {
    id: "expired-snapshot",
    schemaVersion: "portfolio-snapshot.v1",
    sourceRevision: "risk:expired-snapshot",
    calculatedAt: "2026-08-05T07:30:00.000Z",
    effectiveAt: "2026-08-05T08:00:00.000Z",
    expiresAt: "2026-08-06T08:00:00.000Z",
    positions: [{ instrumentId: "SSE:600000", quantity: 100, averageCost: 10 }],
    cash: 500,
    rulesVersion: "risk-rules.v1.2",
    reliable: true,
    warnings: [],
    fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-08-05T08:00:00.000Z",
    stoppedAt: null,
  };
  const service = new CloseReviewService({ getCurrentSnapshot: async () => snapshot });
  const result = await service.execute({ runId: "run-expired", command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-expired" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1", portfolioSnapshot: portfolio });

  assert.equal(result.result.mode, "market-only");
  assert.equal(result.evidence.items.some((item) => item.kind === "portfolio_impact"), false);
  assert.doesNotMatch(JSON.stringify(result.evidence), /"positions"/);
  assert.ok(result.evidence.items.some((item) => item.kind === "limitation" && JSON.stringify(item.value).includes("已过期")));
});
