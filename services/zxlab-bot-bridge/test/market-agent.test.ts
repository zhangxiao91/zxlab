import assert from "node:assert/strict";
import test from "node:test";
import { askMarketAgent } from "../src/market-agent.js";

test("Market Agent Ask uses the private proxy, Access service token, and sealed terminal Evidence", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const result = await askMarketAgent({
    baseUrl: "https://beta.example",
    accessClientId: "access-client-id",
    accessClientSecret: "access-client-secret",
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleep: async () => {},
    fetcher: async (request, init) => {
      const url = new URL(String(request));
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, method: init?.method ?? "GET" });
      assert.equal(headers.get("cf-access-client-id"), "access-client-id");
      assert.equal(headers.get("cf-access-client-secret"), "access-client-secret");
      if (url.pathname.endsWith("/ask")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).sort(), ["idempotencyKey", "instrumentId", "question", "scope"]);
        assert.equal(body.scope, "today_change");
        assert.equal(body.instrumentId, "SSE:600000");
        assert.match(String(body.idempotencyKey), /^bot:/);
        return Response.json({ runId: "ask-run-1", status: "queued", created: true, scope: "today_change" }, { status: 202 });
      }
      if (url.pathname.endsWith("/runs/ask-run-1")) {
        return Response.json({
          id: "ask-run-1",
          workflow: "ask",
          status: "success",
          evidenceFingerprint: "sha256:abc",
          result: { headline: "回答", observations: [] },
        });
      }
      if (url.pathname.endsWith("/runs/ask-run-1/evidence")) {
        return Response.json({ runId: "ask-run-1", evidence: { fingerprint: "sha256:abc", items: [] } });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    },
  }, {
    scope: "today_change",
    instrumentId: "sse:600000",
    question: "今天有什么变化？",
  });

  assert.equal(result.run.status, "success");
  assert.deepEqual(result.evidence, { fingerprint: "sha256:abc", items: [] });
  assert.deepEqual(calls, [
    { path: "/api/private/market-agent/ask", method: "POST" },
    { path: "/api/private/market-agent/runs/ask-run-1", method: "GET" },
    { path: "/api/private/market-agent/runs/ask-run-1/evidence", method: "GET" },
  ]);
});

test("Market Agent Ask fails closed without a Cloudflare Access service token", async () => {
  let called = false;
  await assert.rejects(
    askMarketAgent({
      baseUrl: "https://beta.example",
      timeoutMs: 1_000,
      fetcher: async () => {
        called = true;
        return Response.json({});
      },
    }, { scope: "data_quality" }),
    /Cloudflare Access service-token credentials/,
  );
  assert.equal(called, false);
});
