import assert from "node:assert/strict";
import test from "node:test";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { diffMarketSnapshots } from "./snapshot-diff.ts";

function snapshot(options: {
  asOf: string;
  price: number | null;
}): MarketSnapshot {
  return {
    schemaVersion: "market-snapshot.v1",
    asOf: options.asOf,
    receivedAt: options.asOf,
    marketTimestamp: options.asOf,
    request: {
      instrumentIds: ["SSE:600000"],
      intervals: ["1d"],
      include: ["quotes"],
      quoteMode: "fallback",
    },
    data: {
      quotes: [{
        instrumentId: "SSE:600000",
        price: options.price,
        previousClose: 10,
        open: 10,
        high: 11,
        low: 9,
        volume: 100,
        turnover: 1_000,
        marketTimestamp: options.asOf,
        receivedAt: options.asOf,
        source: "fixture",
        quality: "live",
        stale: false,
        warnings: [],
        corroboration: {
          mode: "fallback",
          status: "not_requested",
          thresholdBps: 50,
          maxDeviationBps: null,
          observations: [],
        },
      }],
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

test("reports the point-in-time quote price delta for the same instrument", () => {
  const previous = snapshot({ asOf: "2026-08-14T01:00:00.000Z", price: 10 });
  const current = snapshot({ asOf: "2026-08-14T02:00:00.000Z", price: 10.25 });

  assert.deepEqual(diffMarketSnapshots(previous, current), {
    previousAsOf: "2026-08-14T01:00:00.000Z",
    currentAsOf: "2026-08-14T02:00:00.000Z",
    changes: [{
      kind: "quote_price",
      instrumentId: "SSE:600000",
      previous: 10,
      current: 10.25,
      delta: 0.25,
      deltaBps: 250,
    }],
  });
});

test("reports aggregate quality and freshness transitions", () => {
  const previous = snapshot({ asOf: "2026-08-14T01:00:00.000Z", price: 10 });
  const current = snapshot({ asOf: "2026-08-14T02:00:00.000Z", price: 10 });
  current.quality.status = "degraded";
  current.quality.reliable = false;
  current.quality.freshness = "stale";

  assert.deepEqual(diffMarketSnapshots(previous, current).changes, [
    {
      kind: "snapshot_quality",
      field: "status",
      previous: "operational",
      current: "degraded",
    },
    {
      kind: "snapshot_quality",
      field: "reliable",
      previous: true,
      current: false,
    },
    {
      kind: "snapshot_quality",
      field: "freshness",
      previous: "fresh",
      current: "stale",
    },
  ]);
});

test("reports capability transitions in stable capability-id order", () => {
  const previous = snapshot({ asOf: "2026-08-14T01:00:00.000Z", price: 10 });
  const current = snapshot({ asOf: "2026-08-14T02:00:00.000Z", price: 10 });
  previous.capabilities = [
    capability("quotes", "operational", "fresh"),
    capability("announcements:SSE", "operational", "mixed"),
  ];
  current.capabilities = [
    capability("quotes", "degraded", "fresh"),
    capability("announcements:SSE", "operational", "stale"),
  ];

  assert.deepEqual(diffMarketSnapshots(previous, current).changes, [
    {
      kind: "capability",
      capabilityId: "announcements:SSE",
      field: "freshness",
      previous: "mixed",
      current: "stale",
    },
    {
      kind: "capability",
      capabilityId: "quotes",
      field: "status",
      previous: "operational",
      current: "degraded",
    },
  ]);
});

function capability(
  id: string,
  status: MarketSnapshot["capabilities"][number]["status"],
  freshness: MarketSnapshot["capabilities"][number]["freshness"],
): MarketSnapshot["capabilities"][number] {
  return {
    id,
    status,
    required: true,
    asOf: "2026-08-14T01:00:00.000Z",
    receivedAt: "2026-08-14T01:00:00.000Z",
    freshness,
    warnings: [],
    attempts: [],
  };
}

test("reports only newly observed news and announcement ids in stable order", () => {
  const previous = snapshot({ asOf: "2026-08-14T01:00:00.000Z", price: 10 });
  const current = snapshot({ asOf: "2026-08-14T02:00:00.000Z", price: 10 });
  previous.data.news = [newsItem("news-existing", "stock-news")];
  previous.data.announcements = [newsItem("announcement-existing", "announcement")];
  current.data.news = [
    newsItem("news-z", "market-news"),
    newsItem("news-existing", "stock-news"),
    newsItem("news-a", "stock-news"),
  ];
  current.data.announcements = [
    newsItem("announcement-new", "announcement"),
    newsItem("announcement-existing", "announcement"),
  ];

  assert.deepEqual(diffMarketSnapshots(previous, current).changes, [
    { kind: "news_added", itemId: "news-a" },
    { kind: "news_added", itemId: "news-z" },
    { kind: "announcement_added", itemId: "announcement-new" },
  ]);
});

function newsItem(
  id: string,
  type: MarketSnapshot["data"]["news"][number]["type"],
): MarketSnapshot["data"]["news"][number] {
  return {
    id,
    type,
    title: id,
    url: `https://example.test/${id}`,
    summary: null,
    content: null,
    source: "fixture",
    publishedAt: "2026-08-14T01:00:00.000Z",
    receivedAt: "2026-08-14T01:00:01.000Z",
    instrumentId: null,
    symbol: null,
    warnings: [],
  };
}
