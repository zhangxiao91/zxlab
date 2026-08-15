import assert from "node:assert/strict";
import test from "node:test";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { researchFactBundleFixture } from "@zxlab/research-fact-schema/fixtures";
import { assessEvidence } from "./evidence-assessment.ts";

const snapshot: MarketSnapshot = {
  schemaVersion: "market-snapshot.v1",
  asOf: "2026-08-13T00:45:57.682Z",
  receivedAt: "2026-08-13T00:46:01.545Z",
  marketTimestamp: "2026-08-12T16:14:41+08:00",
  request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes", "bars", "news", "announcements"], quoteMode: "corroborated" },
  data: { quotes: [], bars: [], news: [], announcements: [], status: [] },
  capabilities: [
    { id: "quotes", status: "operational", required: true, asOf: null, receivedAt: "2026-08-13T00:46:01.545Z", freshness: "fresh", warnings: [], attempts: [] },
    { id: "announcements:SSE:600000", status: "degraded", required: true, asOf: null, receivedAt: "2026-08-13T00:46:01.545Z", freshness: "fresh", warnings: [], attempts: [{ provider: "cninfo-announcement", ok: false, latencyMs: 200, errorCode: "UPSTREAM_HTTP_ERROR", message: null }, { provider: "eastmoney-announcement", ok: true, latencyMs: 180, errorCode: null, message: null }] },
  ],
  quality: { status: "degraded", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] },
};

test("a usable fallback provider keeps evidence sufficient", () => {
  const assessment = assessEvidence("close_review", snapshot, false);

  assert.equal(assessment.coverage, "sufficient");
  assert.equal(assessment.delivery, "fallback");
  assert.deepEqual(assessment.limitations, []);
  assert.deepEqual(assessment.fallbackCapabilities, ["announcements:SSE:600000"]);
});

test("an unavailable required capability limits evidence", () => {
  const unavailable: MarketSnapshot = {
    ...snapshot,
    capabilities: snapshot.capabilities.map((capability) => capability.id.startsWith("announcements")
      ? { ...capability, status: "unavailable", freshness: "unknown", warnings: ["announcement providers unavailable"] }
      : capability),
    quality: { ...snapshot.quality, reliable: false, freshness: "unknown", unavailableCapabilities: ["announcements:SSE:600000"] },
  };

  const assessment = assessEvidence("news_and_announcements", unavailable, false);

  assert.equal(assessment.coverage, "insufficient");
  assert.equal(assessment.limitations[0]?.capability, "announcements:SSE:600000");
});

test("portfolio impact requires a current portfolio snapshot", () => {
  const assessment = assessEvidence("portfolio_impact", snapshot, false);

  assert.equal(assessment.coverage, "insufficient");
  assert.equal(assessment.limitations[0]?.code, "PORTFOLIO_SNAPSHOT_REQUIRED");
});

test("research coverage keeps the subject, metric, window, and sample counts", () => {
  const research = researchFactBundleFixture();
  const baseline = research.capabilities.find((capability) => capability.id === "market_baselines")!;
  baseline.status = "degraded";
  baseline.warnings = ["INSUFFICIENT_SAMPLE"];
  baseline.limitations = [{ code: "INSUFFICIENT_SAMPLE", subjectId: "SSE:600000", baselineType: "realized_volatility", window: 250, actual: 180, required: 251, retryable: false }];

  const assessment = assessEvidence("relative_performance", snapshot, false, research);

  assert.equal(assessment.coverage, "limited");
  assert.match(assessment.limitations.find((item) => item.code === "INSUFFICIENT_SAMPLE")?.message ?? "", /SSE:600000 realized_volatility:250.*180\/251/);
});
