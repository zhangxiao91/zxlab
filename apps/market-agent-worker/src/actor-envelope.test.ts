import assert from "node:assert/strict";
import test from "node:test";
import { actorRequestBodyHash, createActorRequestBinding, signActorEnvelope, subjectHash, verifyActorEnvelope } from "@zxlab/market-agent-schema";

test("signed actor envelope binds delegated owner, scopes, request, and expiry", async () => {
  const request = new Request("https://market-agent.example/api/v1/private/market-agent/profile?source=browser");
  const binding = createActorRequestBinding(request.method, `${new URL(request.url).pathname}${new URL(request.url).search}`, await actorRequestBodyHash(request));
  const payload = {
    version: 2 as const,
    kind: "agent" as const,
    subject: "access-service-token-1",
    ownerSubject: "access-user-1",
    actorId: "codex-side-debug",
    scopes: ["market-agent:read"],
    audience: "market-agent" as const,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_060,
    jti: "actor-envelope-test-1",
    request: binding,
  };
  const envelope = await signActorEnvelope(payload, "shared-secret");
  assert.deepEqual(await verifyActorEnvelope(envelope, "shared-secret", { now: 1_700_000_030_000, request: binding }), payload);
  await assert.rejects(() => verifyActorEnvelope(envelope, "wrong-secret", { now: 1_700_000_030_000, request: binding }), /ACTOR_ENVELOPE_INVALID/);
  await assert.rejects(() => verifyActorEnvelope(envelope, "shared-secret", { now: 1_700_000_061_000, request: binding }), /ACTOR_ENVELOPE_INVALID/);
  await assert.rejects(() => verifyActorEnvelope(envelope, "shared-secret", { now: 1_700_000_030_000, request: { ...binding, path: "/api/v1/private/market-agent/export" } }), /ACTOR_ENVELOPE_INVALID/);
  assert.match(await subjectHash(payload.ownerSubject, "shared-secret"), /^sha256:[a-f0-9]{64}$/);
});
