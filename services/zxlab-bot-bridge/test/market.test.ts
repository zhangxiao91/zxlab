import test from "node:test";
import assert from "node:assert/strict";
import { fetchMarketQuotes, fetchMarketStatus } from "../src/market.js";

test("preserves quote freshness and source fields", async () => {
  const quotes = await fetchMarketQuotes({
    baseUrl: "https://market.example",
    timeoutMs: 1_000,
    fetcher: async (request) => {
      assert.match(String(request), /instruments=SSE%3A510300/);
      return Response.json({ data: [{
        instrumentId: "SSE:510300",
        price: 4.7,
        previousClose: 4.8,
        marketTimestamp: "2026-07-24T15:00:00+08:00",
        receivedAt: "2026-07-25T00:00:00Z",
        source: "tencent-qt",
        quality: "stale",
        stale: true,
        warnings: ["报价已过期"],
      }] });
    },
  }, ["SSE:510300"]);
  assert.equal(quotes[0]?.quality, "stale");
  assert.equal(quotes[0]?.source, "tencent-qt");
  assert.deepEqual(quotes[0]?.warnings, ["报价已过期"]);
});

test("reads exchange status", async () => {
  const status = await fetchMarketStatus({
    baseUrl: "https://market.example",
    timeoutMs: 1_000,
    fetcher: async () => Response.json({ data: {
      exchange: "SSE",
      open: false,
      marketTimestamp: "2026-07-25T10:00:00+08:00",
      source: "calendar",
      warnings: [],
    } }),
  }, "SSE");
  assert.equal(status.open, false);
});
