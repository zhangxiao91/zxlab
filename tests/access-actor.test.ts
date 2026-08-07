import assert from "node:assert/strict";
import test from "node:test";
import { actorHasScope, requireActorScope, resolveAccessActor } from "../functions/_lib/access/actor.ts";
import { RiskReviewError } from "../functions/_lib/risk/review.ts";

const humanClaims = async () => ({ sub: "human-subject" }) as never;

test("access actor resolves a passkey browser identity without an email claim", async () => {
  const actor = await resolveAccessActor(new Request("https://beta.zxlab.pages.dev/api/private/market-agent/profile"), {}, { verifyAccess: humanClaims });
  assert.deepEqual(actor, {
    kind: "human",
    subject: "human-subject",
    ownerSubject: "human-subject",
    actorId: "access:human-subject",
    scopes: ["*"],
  });
  assert.equal(actorHasScope(actor, "market-agent:write"), true);
});

test("access actor resolves a registered machine identity to its delegated owner and scopes", async () => {
  const env = {
    ZX_ACCESS_SERVICE_ACTORS: JSON.stringify([{
      clientId: "service-token-client-id",
      actorId: "codex-side-debug",
      ownerSubject: "debug-owner-subject",
      scopes: ["market-agent:read", "market-agent:write"],
    }]),
  };
  const actor = await resolveAccessActor(new Request("https://beta.zxlab.pages.dev/api/private/market-agent/profile", { headers: { "cf-access-client-id": "client-id", "cf-access-client-secret": "client-secret" } }), env, {
    verifyAccess: async () => ({ sub: "", common_name: "service-token-client-id", aud: "debug-audience" }) as never,
  });
  assert.equal(actor.kind, "agent");
  assert.equal(actor.subject, "service:service-token-client-id");
  assert.equal(actor.ownerSubject, "debug-owner-subject");
  assert.equal(actorHasScope(actor, "market-agent:write"), true);
  assert.equal(actorHasScope(actor, "signal:read"), false);
  assert.throws(() => requireActorScope(actor, "signal:read"), (error: unknown) => error instanceof RiskReviewError && error.code === "ACCESS_SCOPE_REQUIRED");
});

test("access actor fails closed for an unregistered or malformed machine configuration", async () => {
  const request = new Request("https://beta.zxlab.pages.dev/api/private/market-agent/profile", { headers: { "cf-access-client-id": "client-id", "cf-access-client-secret": "client-secret" } });
  await assert.rejects(
    () => resolveAccessActor(request, {}, { verifyAccess: async () => ({ sub: "", common_name: "unregistered-service-client-id" }) as never }),
    (error: unknown) => error instanceof RiskReviewError && error.code === "ACCESS_SERVICE_ACTOR_UNREGISTERED",
  );
  await assert.rejects(
    () => resolveAccessActor(
      new Request("https://debug-beta.zxlab.pages.dev/api/private/market-agent/profile"),
      { RISK_ACCESS_AUD: "human-audience", ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS: JSON.stringify(["debug-audience"]) },
      { verifyAccess: async () => ({ sub: "", common_name: "unregistered-service-client-id", aud: "debug-audience" }) as never },
    ),
    (error: unknown) => error instanceof RiskReviewError && error.code === "ACCESS_SERVICE_ACTOR_UNREGISTERED",
  );
  await assert.rejects(
    () => resolveAccessActor(
      new Request("https://debug-beta.zxlab.pages.dev/api/private/market-agent/profile"),
      { RISK_ACCESS_AUD: "human-audience", ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS: JSON.stringify(["debug-audience"]) },
      { verifyAccess: async () => ({ sub: "debug-human-subject", aud: "debug-audience" }) as never },
    ),
    (error: unknown) => error instanceof RiskReviewError && error.code === "ACCESS_SERVICE_ACTOR_IDENTITY_MISSING",
  );
  await assert.rejects(
    () => resolveAccessActor(request, { ZX_ACCESS_SERVICE_ACTORS: "not-json" }, { verifyAccess: humanClaims }),
    (error: unknown) => error instanceof RiskReviewError && error.code === "ACCESS_SERVICE_ACTORS_INVALID",
  );
});

test("private proxy accepts a separately-audienced registered debug Access service actor", async () => {
  let audiences: readonly string[] | undefined;
  const actor = await resolveAccessActor(
    new Request("https://debug-beta.zxlab.pages.dev/api/private/market-agent/profile"),
    {
      RISK_ACCESS_AUD: "human-audience",
      ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS: JSON.stringify(["debug-audience"]),
      ZX_ACCESS_SERVICE_ACTORS: JSON.stringify([{
        clientId: "debug-service-token-client-id",
        actorId: "codex-debug-agent",
        ownerSubject: "debug-owner-subject",
        scopes: ["market-agent:read"],
      }]),
    },
    {
      verifyAccess: async (_request, _env, options) => {
        audiences = options?.audiences;
        return { sub: "", common_name: "debug-service-token-client-id", aud: "debug-audience" } as never;
      },
    },
  );
  assert.deepEqual(audiences, ["human-audience", "debug-audience"]);
  assert.deepEqual(actor, {
    kind: "agent",
    subject: "service:debug-service-token-client-id",
    ownerSubject: "debug-owner-subject",
    actorId: "codex-debug-agent",
    scopes: ["market-agent:read"],
  });
});
