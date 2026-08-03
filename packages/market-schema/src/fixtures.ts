import { MARKET_SNAPSHOT_SCHEMA_VERSION, type MarketFactQuality, type MarketSnapshot } from "./index.ts";

export function marketSnapshotFixture(quality: MarketFactQuality = "live"): MarketSnapshot {
  const now = "2026-08-03T02:00:00.000Z";
  const unavailable = quality === "unavailable";
  const conflicted = quality === "conflicted";
  const stale = quality === "stale";
  const capabilityStatus = unavailable ? "unavailable" : quality === "live" ? "operational" : "degraded";
  const quote = {
    instrumentId: "SSE:512480",
    price: unavailable ? null : .9,
    previousClose: .89,
    open: .895,
    high: .91,
    low: .89,
    volume: 100,
    turnover: 90,
    marketTimestamp: unavailable ? null : now,
    receivedAt: now,
    source: unavailable ? "unavailable" : "tencent-qt",
    quality,
    stale,
    warnings: unavailable ? ["quote unavailable"] : conflicted ? ["quote sources conflict"] : stale ? ["quote stale"] : [],
    corroboration: {
      mode: "corroborated" as const,
      status: conflicted ? "conflicted" as const : unavailable ? "limited" as const : "corroborated" as const,
      thresholdBps: 50,
      maxDeviationBps: conflicted ? 110 : unavailable ? null : 10,
      observations: unavailable ? [] : [{ provider: "tencent-qt", price: .9, marketTimestamp: now, receivedAt: now }, { provider: "sina-hq", price: conflicted ? .91 : .9009, marketTimestamp: now, receivedAt: now }],
    },
  };
  return {
    schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
    asOf: now,
    receivedAt: now,
    marketTimestamp: quote.marketTimestamp,
    request: { instrumentIds: ["SSE:512480"], intervals: ["1m"], include: ["quotes"], quoteMode: "corroborated" },
    data: { quotes: [quote], bars: [], news: [], announcements: [], status: [{ exchange: "SSE", open: true, session: "open", calendarDate: "2026-08-03", marketTimestamp: now, asOf: now, receivedAt: now, freshness: "fresh", quality: "operational", reliable: true, source: "sse-calendar-2026", warnings: [] }] },
    capabilities: [{ id: "quotes", status: capabilityStatus, required: true, asOf: quote.marketTimestamp, receivedAt: now, freshness: stale ? "stale" : unavailable ? "unknown" : "fresh", warnings: quote.warnings, attempts: [] }],
    quality: { status: capabilityStatus, reliable: !unavailable && !conflicted && !stale, freshness: stale ? "stale" : unavailable ? "unknown" : "fresh", warnings: quote.warnings, attempts: [], unavailableCapabilities: unavailable ? ["quotes"] : [] },
  };
}
