import assert from "node:assert/strict";
import test from "node:test";
import { validateMarketSnapshot, type MarketSnapshotRequest } from "../../../packages/market-schema/src/index.ts";
import { readCurrentMarketSnapshot, type SnapshotReaderDependencies } from "./snapshot.ts";

const now = "2026-08-03T02:00:00.000Z";
const request: MarketSnapshotRequest = { instrumentIds: ["SSE:512480"], intervals: ["1m"], include: ["quotes", "bars"], quoteMode: "fallback" };
const liveReference = { requestedCalendarDate: "2026-08-03", effectiveTradingDate: "2026-08-03", session: "open" as const, semantics: "live_session" as const };

function dependencies(overrides: Partial<SnapshotReaderDependencies> = {}): SnapshotReaderDependencies {
  return {
    now: () => now,
    loadQuotes: async () => ({ data: [{ instrumentId: "SSE:512480", price: .9, previousClose: .89, open: .895, high: .91, low: .89, volume: 100, turnover: 90, marketTimestamp: now, receivedAt: now, source: "tencent-qt", quality: "live", stale: false, warnings: [], fallbackUsed: false, providerAttempts: [], corroboration: { mode: "fallback", status: "not_requested", thresholdBps: 50, maxDeviationBps: null, observations: [] } }], meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh", reference: liveReference } }),
    loadBars: async () => ({ data: [{ instrumentId: "SSE:512480", timestamp: now, open: null, high: null, low: null, close: .9, volume: 1, turnover: 1, source: "tencent-minute" }], meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh", reference: liveReference } }),
    loadNews: async () => ({ data: [], meta: {} }),
    loadAnnouncements: async () => ({ data: [], meta: {} }),
    loadStatus: async (exchange) => ({ data: { exchange, open: true, session: "open", calendarDate: "2026-08-03", marketTimestamp: now, asOf: now, receivedAt: now, freshness: "fresh", quality: "operational", reliable: true, source: "official", warnings: [], reference: liveReference }, meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh", reference: liveReference } }),
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

test("keeps a fresh cached quote operational and reliable", async () => {
  const snapshot = await readCurrentMarketSnapshot(request, dependencies({
    loadQuotes: async () => {
      const result = await dependencies().loadQuotes(["SSE:512480"], "fallback");
      return { ...result, data: result.data.map((quote) => ({ ...quote, quality: "cached" as const })) };
    },
  }));

  const quotes = snapshot.capabilities.find((capability) => capability.id === "quotes");
  assert.deepEqual(
    [quotes?.status, quotes?.freshness, snapshot.quality.status, snapshot.quality.reliable, snapshot.quality.freshness],
    ["operational", "fresh", "operational", true, "fresh"],
  );
});

test("keeps fresh fallback data fresh without upgrading its degraded provider health", async () => {
  const snapshot = await readCurrentMarketSnapshot(request, dependencies({
    loadQuotes: async () => {
      const result = await dependencies().loadQuotes(["SSE:512480"], "fallback");
      return {
        ...result,
        data: result.data.map((quote) => ({ ...quote, fallbackUsed: true })),
        meta: { ...result.meta, capabilityStatus: "degraded", freshness: "fresh", fallbackUsed: true },
      };
    },
  }));

  const quotes = snapshot.capabilities.find((capability) => capability.id === "quotes");
  assert.deepEqual(
    [quotes?.status, quotes?.freshness, snapshot.quality.status, snapshot.quality.reliable, snapshot.quality.freshness],
    ["degraded", "fresh", "degraded", true, "fresh"],
  );
});

test("a stale required bar capability cannot remain reliable", async () => {
  const snapshot = await readCurrentMarketSnapshot(request, dependencies({
    loadBars: async () => {
      const result = await dependencies().loadBars("SSE:512480", "1m");
      return {
        ...result,
        meta: { ...result.meta, capabilityStatus: "degraded", freshness: "stale" },
      };
    },
  }));

  assert.equal(snapshot.quality.status, "degraded");
  assert.equal(snapshot.quality.reliable, false);
  assert.equal(snapshot.quality.freshness, "stale");
  assert.equal(validateMarketSnapshot(snapshot).ok, true);
});

test("seals one pinned Sunday market reference across quotes, daily bars, minute bars, and status", async () => {
  const sunday = "2026-08-16T07:52:55.693Z";
  const friday = "2026-08-14T07:00:00.000Z";
  const reference = { requestedCalendarDate: "2026-08-16", effectiveTradingDate: "2026-08-14", session: "holiday" as const, semantics: "last_effective_session" as const };
  const sundayRequest: MarketSnapshotRequest = { ...request, intervals: ["1d", "1m"] };
  const snapshot = await readCurrentMarketSnapshot(sundayRequest, dependencies({
    now: () => sunday,
    loadQuotes: async () => ({ data: [{ instrumentId: "SSE:512480", price: .9, previousClose: .89, open: .895, high: .91, low: .89, volume: 100, turnover: 90, marketTimestamp: friday, receivedAt: sunday, source: "tencent-qt", quality: "live", stale: false, warnings: [], corroboration: { mode: "fallback", status: "not_requested", thresholdBps: 50, maxDeviationBps: null, observations: [] } }], meta: { capabilityStatus: "operational", asOf: friday, receivedAt: sunday, freshness: "fresh", reference } }),
    loadBars: async (instrumentId, interval) => ({ data: [{ instrumentId, timestamp: friday, open: null, high: null, low: null, close: .9, volume: 1, turnover: 1, source: interval === "1d" ? "daily" : "minute" }], meta: { capabilityStatus: "operational", asOf: friday, receivedAt: sunday, freshness: "fresh", reference } }),
    loadStatus: async (exchange) => ({ data: { exchange, open: false, session: "holiday", calendarDate: "2026-08-16", marketTimestamp: sunday, asOf: sunday, receivedAt: sunday, freshness: "fresh", quality: "operational", reliable: true, source: "official", warnings: [], reference }, meta: { capabilityStatus: "operational", asOf: sunday, receivedAt: sunday, freshness: "fresh", reference } }),
  }));

  assert.deepEqual(snapshot.reference, reference);
  assert.equal(snapshot.quality.reliable, true);
  assert.equal(snapshot.quality.freshness, "fresh");
  assert.equal(validateMarketSnapshot(snapshot).ok, true);
});

test("fails closed when current capabilities disagree on the market reference", async () => {
  await assert.rejects(
    readCurrentMarketSnapshot(request, dependencies({
      loadBars: async () => ({
        data: [],
        meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh", reference: { ...liveReference, effectiveTradingDate: "2026-07-31" } },
      }),
    })),
    /MARKET_REFERENCE_INCONSISTENT/,
  );
});

test("fails closed when a successful temporal capability omits its market reference", async () => {
  await assert.rejects(
    readCurrentMarketSnapshot(request, dependencies({
      loadBars: async () => ({ data: [], meta: { capabilityStatus: "operational", asOf: now, receivedAt: now, freshness: "fresh" } }),
    })),
    /MARKET_REFERENCE_MISSING:bars:SSE:512480:1m/,
  );
});
