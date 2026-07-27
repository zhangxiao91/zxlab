import assert from "node:assert/strict";
import test from "node:test";
import { proxyPrivateRequest, type PrivateProxyEnv } from "../functions/_lib/private-proxy.ts";
import { RiskReviewError } from "../functions/_lib/risk/review.ts";

const env: PrivateProxyEnv = {
  RISK_ACCESS_TEAM_DOMAIN: "https://zxdx1.cloudflareaccess.com",
  RISK_ACCESS_AUD: "pages-audience",
  ZX_RUNTIME_SERVICE_TOKEN: "server-only-token",
};
const verifyAccess = async () => ({}) as never;

test("private proxy forwards only the server token to Runtime", async () => {
  let forwarded: Request | undefined;
  const response = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/runtime/api/v1/private/overview?view=all", { headers: { cookie: "CF_Authorization=browser-token" } }), env },
    "runtime",
    "api/v1/private/overview",
    {
      verifyAccess,
      fetcher: async (input, init) => {
        forwarded = new Request(input, init);
        return Response.json({ ok: true });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded?.url, "https://runtime-api.zx-dx.xyz/api/v1/private/overview?view=all");
  assert.equal(forwarded?.headers.get("authorization"), "Bearer server-only-token");
  assert.equal(forwarded?.headers.has("cookie"), false);
  assert.equal(response.headers.has("authorization"), false);
});

test("private proxy rejects paths outside each service allowlist", async () => {
  let called = false;
  const response = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/signal/health"), env },
    "signal",
    "health",
    { verifyAccess, fetcher: async () => { called = true; return new Response(); } },
  );
  assert.equal(response.status, 404);
  assert.equal(called, false);
  assert.match(await response.text(), /PRIVATE_ROUTE_NOT_ALLOWED/);
});

test("private Signal requests travel through the Runtime service-binding bridge", async () => {
  let forwardedUrl = "";
  let forwardedAuthorization: string | null = null;
  const response = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/signal/api/annotations?stream=1", { method: "POST", body: "{}" }), env },
    "signal",
    "api/annotations",
    {
      verifyAccess,
      fetcher: async (input, init) => {
        forwardedUrl = String(input);
        forwardedAuthorization = new Headers(init?.headers).get("authorization");
        return new Response("ok", { headers: { "content-type": "text/event-stream" } });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, "https://runtime-api.zx-dx.xyz/api/v1/private/signal/api/annotations?stream=1");
  assert.equal(forwardedAuthorization, "Bearer server-only-token");
});

test("private proxy fails closed before contacting an upstream without Access", async () => {
  let called = false;
  const response = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/runtime/api/v1/private/overview"), env },
    "runtime",
    "api/v1/private/overview",
    {
      verifyAccess: async () => { throw new RiskReviewError("ACCESS_REQUIRED", "Sign in required.", 401); },
      fetcher: async () => { called = true; return new Response(); },
    },
  );
  assert.equal(response.status, 401);
  assert.equal(called, false);
});
