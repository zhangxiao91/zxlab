import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.ts";

test("private routes reject unauthenticated requests before body parsing and database readiness", async () => {
  for (const item of [
    { path: "/ask", method: "POST" },
    { path: "/runs/run-1/dossier-projection/rebase", method: "POST" },
    { path: "/dossiers/SSE%3A600000/thesis-proposals", method: "POST" },
    { path: "/dossiers/SSE%3A600000", method: "DELETE" },
    { path: "/dossier-proposals/proposal-1/confirm", method: "POST" },
    { path: "/dossier-proposals/proposal-1/dismiss", method: "POST" },
    { path: "/dossier-proposals/proposal-1/alert-rule-drafts", method: "POST" },
  ]) {
    const request = new Request(`https://agent.example/api/v1/private/market-agent${item.path}`, {
      method: item.method,
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const response = await worker.fetch(request, {
      MARKET_AGENT_PROXY_TOKEN: "proxy-secret",
    } as Env);

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});
