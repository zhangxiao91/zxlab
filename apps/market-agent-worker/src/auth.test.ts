import assert from "node:assert/strict";
import test from "node:test";
import { actorRequestBodyHash, createActorRequestBinding, signActorEnvelope } from "@zxlab/market-agent-schema";
import { requireMarketAgentScope, resolveMarketAgentActor } from "./auth.ts";

async function signedRequest(body: string) {
  const url = "https://market-agent.example/api/v1/private/market-agent/watchlist";
  const unsigned = new Request(url, { method: "POST", body, headers: { "content-type": "application/json" } });
  const request = createActorRequestBinding("POST", new URL(url).pathname, await actorRequestBodyHash(unsigned));
  const envelope = await signActorEnvelope({
    version: 2,
    kind: "agent",
    subject: "service-token-subject",
    ownerSubject: "debug-owner-subject",
    actorId: "codex-side-debug",
    scopes: ["market-agent:read"],
    audience: "market-agent",
    issuedAt: Math.floor(Date.now() / 1_000),
    expiresAt: Math.floor(Date.now() / 1_000) + 60,
    jti: crypto.randomUUID(),
    request,
  }, "proxy-secret");
  return new Request(url, {
    method: "POST",
    body,
    headers: { authorization: "Bearer proxy-secret", "content-type": "application/json", "x-zx-actor": envelope },
  });
}

test("market agent auth verifies the request-bound envelope and keeps agent scopes", async () => {
  const request = await signedRequest('{"revision":"one"}');
  const actor = await resolveMarketAgentActor(request, { MARKET_AGENT_PROXY_TOKEN: "proxy-secret" });
  assert.equal(actor.ownerSubject, "debug-owner-subject");
  assert.throws(() => requireMarketAgentScope(actor, "POST"), /ACTOR_SCOPE_REQUIRED/);
  assert.doesNotThrow(() => requireMarketAgentScope(actor, "GET"));
});

test("market agent auth rejects a signed envelope replayed with a different body", async () => {
  const request = await signedRequest('{"revision":"one"}');
  const altered = new Request(request.url, {
    method: request.method,
    body: '{"revision":"two"}',
    headers: request.headers,
  });
  await assert.rejects(() => resolveMarketAgentActor(altered, { MARKET_AGENT_PROXY_TOKEN: "proxy-secret" }), /ACTOR_ENVELOPE_INVALID/);
});
