import assert from "node:assert/strict";
import test from "node:test";
import { CloseReviewService } from "./close-review.ts";
import type { MarketSnapshot } from "@zxlab/market-schema";

const snapshot: MarketSnapshot = { schemaVersion: "market-snapshot.v1", asOf: "2026-08-05T08:00:00.000Z", receivedAt: "2026-08-05T08:00:01.000Z", marketTimestamp: "2026-08-05T07:59:00.000Z", request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" }, data: { quotes: [{ instrumentId: "SSE:600000", price: 12, previousClose: 10, open: 10, high: 12, low: 10, volume: 100, turnover: 1200, marketTimestamp: "2026-08-05T07:59:00.000Z", receivedAt: "2026-08-05T08:00:01.000Z", source: "fixture", quality: "live", stale: false, warnings: [], corroboration: { mode: "corroborated", status: "corroborated", thresholdBps: 50, maxDeviationBps: 10, observations: [] } }], bars: [], news: [], announcements: [], status: [] }, capabilities: [], quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] } };

test("close review seals evidence before narration", async () => {
  const service = new CloseReviewService({ getCurrentSnapshot: async () => snapshot });
  const result = await service.execute({ runId: "run-1", command: { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "close-review-1" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });
  assert.equal(result.result.mode, "market-only"); assert.equal(result.evidence.items.some((item) => item.kind === "market_event"), true); assert.equal(result.result.observations[0]?.evidenceIds[0], result.evidence.items.at(-1)?.id);
});

test("morning brief keeps its workflow through sealed evidence and narration", async () => {
  const service = new CloseReviewService({ getCurrentSnapshot: async () => snapshot });
  const result = await service.execute({ runId: "run-morning", command: { profileId: "p1", trigger: "scheduled", workflow: "morning_brief", idempotencyKey: "morning-brief-1" }, instrumentIds: ["SSE:600000"], watchlistRevision: "w1" });
  assert.equal(result.evidence.workflow, "morning_brief");
  assert.match(result.result.headline, /盘前简报/);
});
