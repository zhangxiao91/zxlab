import assert from "node:assert/strict";
import test from "node:test";
import { proxyRiskMarket } from "../functions/_lib/market/proxy.ts";
import { resolveMarketChartKind } from "../src/features/market/chart-model.ts";
import { capabilityHealth, LatestMarketRequest, summarizeMarketDataQuality } from "../src/features/market/quality.ts";
import { marketStatusPresentation, quoteQualityPresentation } from "../src/features/market/presentation.ts";
import type { MarketBar, MarketResponse } from "../src/features/market/types.ts";
import { MarketClient } from "../src/features/market/client.ts";
import { marketSnapshotFixture } from "../packages/market-schema/src/fixtures.ts";

const closeOnly = (timestamp: string, close: number): MarketBar => ({ instrumentId: "SSE:512480", timestamp, open: null, high: null, low: null, close, volume: 1, turnover: 1 });

test("close-only minute data renders as a line instead of waiting for OHLC", () => {
  assert.equal(resolveMarketChartKind([closeOnly("2026-08-03T09:30:00+08:00", .9), closeOnly("2026-08-03T09:31:00+08:00", .91)]), "line");
});

test("partial and total capability failure cannot remain operational", () => {
  const ok = capabilityHealth({ id: "quote", response: { data: [{ quality: "live" }], meta: { receivedAt: "2026-08-03T01:30:00Z" } } as MarketResponse<Array<{ quality: "live" }>>, itemQualities: ["live"] });
  const failed = capabilityHealth({ id: "minute-bars", error: new Error("minute-bars unavailable"), emptyIsUnavailable: true });
  assert.equal(summarizeMarketDataQuality([ok, failed]).status, "degraded");
  assert.equal(summarizeMarketDataQuality([failed]).status, "unavailable");
  assert.deepEqual(summarizeMarketDataQuality([ok, failed]).unavailableCapabilities, ["minute-bars"]);
});

test("latest-only request gate rejects an older response after instrument switch", () => {
  const gate = new LatestMarketRequest();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test("market presentation distinguishes all fact qualities and unknown calendar state", () => {
  assert.deepEqual(["live", "cached", "stale", "conflicted", "unavailable"].map((quality) => quoteQualityPresentation({ quality: quality as "live" | "cached" | "stale" | "conflicted" | "unavailable" }).label), ["实时", "缓存", "过期", "源冲突", "不可用"]);
  assert.equal(marketStatusPresentation({ open: null, session: "unknown", reliable: false }), "交易状态未知");
  assert.equal(marketStatusPresentation({ open: false, session: "holiday", reliable: true }), "节假日休市");
  assert.equal(marketStatusPresentation({ open: true, session: "open", reliable: true }), "开市");
});

test("same-origin market proxy forwards only the normalized market path through a service binding", async () => {
  const forwarded: Request[] = [];
  const response = await proxyRiskMarket({
    request: new Request("https://beta.zxlab.pages.dev/api/market/quotes?instruments=SSE%3A512480", {
      headers: { authorization: "Bearer must-not-leak", cookie: "private=session" },
    }),
    env: {
      RISK_MARKET: {
        fetch: async (request) => {
          forwarded.push(request);
          return Response.json({ data: [{ instrumentId: "SSE:512480", price: 0.9 }] }, { headers: { "cache-control": "public, max-age=5" } });
        },
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(new URL(forwarded[0].url).pathname, "/api/market/quotes");
  assert.equal(new URL(forwarded[0].url).searchParams.get("instruments"), "SSE:512480");
  assert.equal(forwarded[0].headers.get("authorization"), null);
  assert.equal(forwarded[0].headers.get("cookie"), null);
  assert.equal(response.headers.get("cache-control"), "public, max-age=5");
});

test("same-origin market proxy allows market news and announcements endpoints", async () => {
  const paths: string[] = [];
  const env = {
    RISK_MARKET: {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        paths.push(`${url.pathname}${url.search}`);
        return Response.json({ data: [], meta: { attempts: [] } });
      },
    },
  };
  const news = await proxyRiskMarket({ request: new Request("https://beta.zxlab.pages.dev/api/market/news?instruments=SSE%3A512480&limit=8"), env });
  const announcements = await proxyRiskMarket({ request: new Request("https://beta.zxlab.pages.dev/api/market/announcements?instrument=SSE%3A512480&limit=5"), env });
  assert.equal(news.status, 200);
  assert.equal(announcements.status, 200);
  assert.deepEqual(paths, ["/api/market/news?instruments=SSE%3A512480&limit=8", "/api/market/announcements?instrument=SSE%3A512480&limit=5"]);
});

test("same-origin market proxy allows the aggregate snapshot endpoint", async () => {
  const paths: string[] = [];
  const response = await proxyRiskMarket({
    request: new Request("https://beta.zxlab.pages.dev/api/market/snapshot?ids=SSE%3A512480&include=quotes%2Cbars&intervals=1m&quoteMode=corroborated"),
    env: { RISK_MARKET: { fetch: async (request: Request) => { paths.push(new URL(request.url).pathname); return Response.json({ data: { schemaVersion: "market-snapshot.v1" } }); } } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(paths, ["/api/market/snapshot"]);
});

test("MarketClient validates aggregate snapshots at the shared seam", async () => {
  const client = new MarketClient("https://market.example", async () => Response.json({ data: marketSnapshotFixture("cached"), meta: { freshness: "mixed" } }));
  const response = await client.getSnapshot({ instrumentIds: ["SSE:512480"], intervals: ["1m"], include: ["quotes"], quoteMode: "fallback" });
  assert.equal(response.data.schemaVersion, "market-snapshot.v1");
  assert.equal(response.data.data.quotes[0]?.quality, "cached");
  const invalid = new MarketClient("https://market.example", async () => Response.json({ data: { schemaVersion: "wrong" } }));
  await assert.rejects(() => invalid.getSnapshot({ instrumentIds: ["SSE:512480"], intervals: ["1m"], include: ["quotes"], quoteMode: "fallback" }), /Invalid MarketSnapshot/);
});

test("same-origin market proxy rejects unsupported methods and paths", async () => {
  const method = await proxyRiskMarket({ request: new Request("https://example.com/api/market/quotes", { method: "POST" }), env: {} });
  assert.equal(method.status, 405);
  const path = await proxyRiskMarket({ request: new Request("https://example.com/api/market/private"), env: {} });
  assert.equal(path.status, 404);
});
