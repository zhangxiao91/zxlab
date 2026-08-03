import assert from "node:assert/strict";
import test from "node:test";
import { validateMarketSnapshot, type MarketSnapshotRequest } from "../../../packages/market-schema/src/index.ts";
import { readCurrentMarketSnapshot, type SnapshotReaderDependencies } from "./snapshot.ts";

const now = "2026-08-03T02:00:00.000Z";
const request: MarketSnapshotRequest = { instrumentIds: ["SSE:512480"], intervals: ["1m"], include: ["quotes", "bars"], quoteMode: "fallback" };

function dependencies(overrides: Partial<SnapshotReaderDependencies> = {}): SnapshotReaderDependencies {
  return {
    now: () => now,
    loadQuotes: async () => ({ data: [{ instrumentId: "SSE:512480", price: .9, previousClose: .89, open: .895, high: .91, low: .89, volume: 100, turnover: 90, marketTimestamp: now, receivedAt: now, source: "tencent-qt", quality: "live", stale: false, warnings: [], fallbackUsed: false, providerAttempts: [], corroboration: { mode: "fallback", status: "not_requested", thresholdBps: 50, maxDeviationBps: null, observations: [] } }], meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh" } }),
    loadBars: async () => ({ data: [{ instrumentId: "SSE:512480", timestamp: now, open: null, high: null, low: null, close: .9, volume: 1, turnover: 1, source: "tencent-minute" }], meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh" } }),
    loadNews: async () => ({ data: [], meta: {} }),
    loadAnnouncements: async () => ({ data: [], meta: {} }),
    loadStatus: async (exchange) => ({ data: { exchange, open: true, session: "open", calendarDate: "2026-08-03", marketTimestamp: now, asOf: now, receivedAt: now, freshness: "fresh", quality: "operational", reliable: true, source: "official", warnings: [] }, meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh" } }),
    ...overrides,
  };
}

test("aggregates a validated fallback snapshot without claiming corroboration", async () => {
  const snapshot = await readCurrentMarketSnapshot(request, dependencies());
  assert.equal(validateMarketSnapshot(snapshot).ok, true);
  assert.equal(snapshot.quality.status, "operational");
  assert.equal(snapshot.quality.reliable, true);
  assert.equal(snapshot.data.quotes[0]?.corroboration?.status, "not_requested");
  assert.equal(snapshot.asOf, now);
});

test("preserves partial capability failure, warnings and attempts", async () => {
  const snapshot = await readCurrentMarketSnapshot(request, dependencies({ loadBars: async () => { throw Object.assign(new Error("minute bars unavailable"), { attempts: [{ provider: "primary", ok: false, latencyMs: 10, errorCode: "TIMEOUT", message: "timeout" }] }); } }));
  assert.equal(snapshot.quality.status, "degraded");
  assert.equal(snapshot.quality.reliable, false);
  assert.deepEqual(snapshot.quality.unavailableCapabilities, ["bars:SSE:512480:1m"]);
  assert.match(snapshot.quality.warnings.join(" "), /minute bars unavailable/);
  assert.equal(snapshot.quality.attempts[0]?.provider, "primary");
});

test("marks the snapshot unavailable when every requested market fact fails", async () => {
  const snapshot = await readCurrentMarketSnapshot(request, dependencies({ loadQuotes: async () => { throw new Error("quotes unavailable"); }, loadBars: async () => { throw new Error("bars unavailable"); } }));
  assert.equal(snapshot.quality.status, "unavailable");
  assert.equal(snapshot.quality.reliable, false);
});

test("normalizes adapter quotes and records snapshot completion separately from observation start", async () => {
  let tick = 0;
  const snapshot = await readCurrentMarketSnapshot(request, dependencies({
    now: () => [now, "2026-08-03T02:00:01.000Z"][tick++] ?? "2026-08-03T02:00:01.000Z",
    loadQuotes: async () => {
      const result = await dependencies().loadQuotes(["SSE:512480"], "fallback");
      return { ...result, data: result.data.map(({ corroboration: _corroboration, ...quote }) => quote) };
    },
  }));
  assert.equal(snapshot.asOf, now);
  assert.equal(snapshot.receivedAt, "2026-08-03T02:00:01.000Z");
  assert.equal(snapshot.data.quotes[0]?.corroboration.status, "not_requested");
});
