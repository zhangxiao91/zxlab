import assert from "node:assert/strict";
import test from "node:test";
import type { PortfolioSnapshot } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { evaluatePortfolioRiskImpact } from "./portfolio-risk-impact.ts";

const NOW = Date.parse("2026-08-07T08:00:00.000Z");

function portfolio(expiresAt = "2026-08-08T08:00:00.000Z"): PortfolioSnapshot {
  return {
    id: "snapshot-1",
    schemaVersion: "portfolio-snapshot.v1",
    sourceRevision: "risk:snapshot-1",
    calculatedAt: "2026-08-07T07:30:00.000Z",
    effectiveAt: "2026-08-07T08:00:00.000Z",
    expiresAt,
    positions: [{ instrumentId: "SSE:600000", quantity: 100, averageCost: 10 }],
    cash: 500,
    rulesVersion: "risk-rules.v1.2",
    reliable: true,
    warnings: [],
    fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-08-07T08:00:00.000Z",
    stoppedAt: null,
  };
}

function market(options: { includeQuote?: boolean; stale?: boolean } = {}): MarketSnapshot {
  const includeQuote = options.includeQuote ?? true;
  return {
    schemaVersion: "market-snapshot.v1",
    asOf: "2026-08-07T08:00:00.000Z",
    receivedAt: "2026-08-07T08:00:01.000Z",
    marketTimestamp: "2026-08-07T07:59:00.000Z",
    request: {
      instrumentIds: ["SSE:600000"],
      intervals: ["1d"],
      include: ["quotes"],
      quoteMode: "corroborated",
    },
    data: {
      quotes: includeQuote
        ? [{
            instrumentId: "SSE:600000",
            price: 12,
            previousClose: 10,
            open: 10,
            high: 12,
            low: 10,
            volume: 100,
            turnover: 1200,
            marketTimestamp: "2026-08-07T07:59:00.000Z",
            receivedAt: "2026-08-07T08:00:01.000Z",
            source: "fixture",
            quality: "live",
            stale: options.stale ?? false,
            warnings: [],
            corroboration: {
              mode: "corroborated",
              status: "corroborated",
              thresholdBps: 50,
              maxDeviationBps: 10,
              observations: [],
            },
          }]
        : [],
      bars: [],
      news: [],
      announcements: [],
      status: [],
    },
    capabilities: [],
    quality: {
      status: "operational",
      reliable: true,
      freshness: "fresh",
      warnings: [],
      attempts: [],
      unavailableCapabilities: [],
    },
  };
}

test("portfolio impact is reliable only with a current snapshot and corroborated live prices", () => {
  const result = evaluatePortfolioRiskImpact(portfolio(), market(), NOW);
  assert.equal(result.reliable, true);
  assert.equal(result.impact?.marketValue, 1200);
  assert.deepEqual(result.limitations, []);
});

test("missing or stale portfolio prices downgrade a run to market-only", () => {
  const missing = evaluatePortfolioRiskImpact(portfolio(), market({ includeQuote: false }), NOW);
  const stale = evaluatePortfolioRiskImpact(portfolio(), market({ stale: true }), NOW);
  assert.equal(missing.reliable, false);
  assert.equal(stale.reliable, false);
  assert.match(missing.limitations.join("\n"), /缺少可用于服务端估值/);
  assert.match(stale.limitations.join("\n"), /缺少可用于服务端估值/);
});

test("expired portfolio snapshots produce no portfolio impact", () => {
  const result = evaluatePortfolioRiskImpact(
    portfolio("2026-08-07T07:59:59.000Z"),
    market(),
    NOW,
  );
  assert.equal(result.reliable, false);
  assert.equal(result.impact, null);
  assert.match(result.limitations[0] ?? "", /已过期/);
});

test("stopped portfolio snapshots produce no portfolio impact", () => {
  const snapshot = { ...portfolio(), stoppedAt: "2026-08-07T07:59:00.000Z" };
  const result = evaluatePortfolioRiskImpact(snapshot, market(), NOW);
  assert.equal(result.reliable, false);
  assert.equal(result.impact, null);
  assert.match(result.limitations[0] ?? "", /已停止/);
});
