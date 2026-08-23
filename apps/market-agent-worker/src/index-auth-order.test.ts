import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.ts";

test("private routes reject unauthenticated requests before database readiness", async () => {
  const request = new Request("https://agent.example/api/v1/private/market-agent/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  const response = await worker.fetch(request, {
    MARKET_AGENT_PROXY_TOKEN: "proxy-secret",
  } as Env);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
