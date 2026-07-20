import assert from "node:assert/strict";
import test from "node:test";
import { proxyRiskMarket } from "../functions/_lib/market/proxy.ts";

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

test("same-origin market proxy rejects unsupported methods and paths", async () => {
  const method = await proxyRiskMarket({ request: new Request("https://example.com/api/market/quotes", { method: "POST" }), env: {} });
  assert.equal(method.status, 405);
  const path = await proxyRiskMarket({ request: new Request("https://example.com/api/market/private"), env: {} });
  assert.equal(path.status, 404);
});
