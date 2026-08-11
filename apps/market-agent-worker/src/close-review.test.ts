import assert from "node:assert/strict";
import test from "node:test";
import { CloseReviewService } from "./close-review.ts";
import type { PortfolioSnapshot } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { canonicalMemoryRevisionHash } from "./confirmed-context.ts";

const snapshot: MarketSnapshot = { schemaVersion: "market-snapshot.v1", asOf: "2026-08-05T08:00:00.000Z", receivedAt: "2026-08-05T08:00:01.000Z", marketTimestamp: "2026-08-05T07:59:00.000Z", request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" }, data: { quotes: [{ instrumentId: "SSE:600000", price: 12, previousClose: 10, open: 10, high: 12, low: 10, volume: 100, turnover: 1200, marketTimestamp: "2026-08-05T07:59:00.000Z", receivedAt: "2026-08-05T08:00:01.000Z", source: "fixture", quality: "live", stale: false, warnings: [], corroboration: { mode: "corroborated", status: "corroborated", thresholdBps: 50, maxDeviationBps: 10, observations: [] } }], bars: [], news: [], announcements: [], status: [] }, capabilities: [], quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] } };

test("close review seals evidence before narration", async () => {
  const service = new CloseReviewService({ getCurrentSnapshot: async () => snapshot });
  const result = await service.execute({ runId: "run-1", command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-1" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });
  assert.equal(result.result.mode, "market-only"); assert.equal(result.evidence.items.some((item) => item.kind === "market_event"), true); assert.equal(result.result.observations[0]?.evidenceIds[0], result.evidence.items.at(-1)?.id);
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
