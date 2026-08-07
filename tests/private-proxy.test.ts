import assert from "node:assert/strict";
import test from "node:test";
import { actorRequestBodyHash, createActorRequestBinding, verifyActorEnvelope } from "@zxlab/market-agent-schema";
import { proxyPrivateRequest, type PrivateProxyEnv } from "../functions/_lib/private-proxy.ts";
import { RiskReviewError } from "../functions/_lib/risk/review.ts";

const env: PrivateProxyEnv = {
  RISK_ACCESS_TEAM_DOMAIN: "https://zxdx1.cloudflareaccess.com",
  RISK_ACCESS_AUD: "pages-audience",
  ZX_RUNTIME_SERVICE_TOKEN: "server-only-token",
  MARKET_AGENT_PROXY_TOKEN: "market-agent-only-token",
};
const verifyAccess = async () => ({ sub: "access-user-1", email: "owner@example.com" }) as never;

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

test("private Market Agent requests use the dedicated upstream and preserve the allowed path", async () => {
  let forwardedUrl = "";
  let forwardedMethod = "";
  let forwardedAuthorization: string | null = null;
  let forwardedActor: string | null = null;
  const response = await proxyPrivateRequest(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/market-agent/runs/run-1/feedback?source=today", {
        method: "POST",
        body: JSON.stringify({ value: "helpful" }),
      }),
      env: { ...env, MARKET_AGENT_API_URL: "https://market-agent.example.com" },
    },
    "market-agent",
    "runs/run-1/feedback",
    {
      verifyAccess,
      fetcher: async (input, init) => {
        forwardedUrl = String(input);
        forwardedMethod = init?.method ?? "";
        forwardedAuthorization = new Headers(init?.headers).get("authorization");
        forwardedActor = new Headers(init?.headers).get("x-zx-actor");
        return Response.json({ ok: true });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, "https://market-agent.example.com/api/v1/private/market-agent/runs/run-1/feedback?source=today");
  assert.equal(forwardedMethod, "POST");
  assert.equal(forwardedAuthorization, "Bearer market-agent-only-token");
  assert.match(forwardedActor ?? "", /^[^.]+\.[^.]+$/);
});

test("private Market Agent deletion stays on the profile-scoped service route", async () => {
  let forwardedUrl = "";
  let forwardedMethod = "";
  const response = await proxyPrivateRequest(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/market-agent/runs/run-1", { method: "DELETE" }),
      env: { ...env, MARKET_AGENT_API_URL: "https://market-agent.example.com" },
    },
    "market-agent",
    "runs/run-1",
    {
      verifyAccess,
      fetcher: async (input, init) => {
        forwardedUrl = String(input);
        forwardedMethod = init?.method ?? "";
        return Response.json({ ok: true });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, "https://market-agent.example.com/api/v1/private/market-agent/runs/run-1");
  assert.equal(forwardedMethod, "DELETE");
});

test("private Market Agent allowlist permits only the portfolio snapshot control routes", async () => {
  const paths = [
    { path: "portfolio-snapshot", method: "GET" },
    { path: "portfolio-snapshot", method: "POST" },
    { path: "portfolio-snapshot/stop", method: "POST" },
    { path: "portfolio-snapshot/purge", method: "POST" },
  ] as const;

  for (const item of paths) {
    let forwardedPath = "";
    const response = await proxyPrivateRequest(
      {
        request: new Request(
          `https://beta.zxlab.pages.dev/api/private/market-agent/${item.path}`,
          {
            method: item.method,
            body: item.method === "GET" ? undefined : "{}",
          },
        ),
        env: { ...env, MARKET_AGENT_API_URL: "https://market-agent.example.com" },
      },
      "market-agent",
      item.path,
      {
        verifyAccess,
        fetcher: async (input) => {
          forwardedPath = new URL(String(input)).pathname;
          return Response.json({ ok: true });
        },
      },
    );
    assert.equal(response.status, 200, item.path);
    assert.equal(
      forwardedPath,
      `/api/v1/private/market-agent/${item.path}`,
    );
  }

  let called = false;
  const rejected = await proxyPrivateRequest(
    {
      request: new Request(
        "https://beta.zxlab.pages.dev/api/private/market-agent/portfolio-snapshot/raw",
      ),
      env,
    },
    "market-agent",
    "portfolio-snapshot/raw",
    { verifyAccess, fetcher: async () => { called = true; return new Response(); } },
  );
  assert.equal(rejected.status, 404);
  assert.equal(called, false);
});

test("private Market Agent allowlist admits the bounded Ask lifecycle only", async () => {
  const paths = [
    { path: "ask", method: "POST" },
    { path: "runs/run-1/evidence", method: "GET" },
  ] as const;

  for (const item of paths) {
    let forwardedPath = "";
    const response = await proxyPrivateRequest(
      {
        request: new Request(
          `https://beta.zxlab.pages.dev/api/private/market-agent/${item.path}`,
          {
            method: item.method,
            body: item.method === "GET" ? undefined : JSON.stringify({
              scope: "today_change",
              instrumentId: "SSE:600000",
              idempotencyKey: "ask-proxy-1",
            }),
          },
        ),
        env: { ...env, MARKET_AGENT_API_URL: "https://market-agent.example.com" },
      },
      "market-agent",
      item.path,
      {
        verifyAccess,
        fetcher: async (input) => {
          forwardedPath = new URL(String(input)).pathname;
          return Response.json({ ok: true });
        },
      },
    );
    assert.equal(response.status, 200, item.path);
    assert.equal(forwardedPath, `/api/v1/private/market-agent/${item.path}`);
  }
});

test("private Market Agent proxy rejects routes outside its narrow allowlist", async () => {
  let called = false;
  const response = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/market-agent/admin"), env },
    "market-agent",
    "admin",
    { verifyAccess, fetcher: async () => { called = true; return new Response(); } },
  );

  assert.equal(response.status, 404);
  assert.equal(called, false);
  assert.match(await response.text(), /PRIVATE_ROUTE_NOT_ALLOWED/);
});

test("private Market Agent proxy prefers its service binding", async () => {
  let forwardedPath = "";
  const response = await proxyPrivateRequest(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/market-agent/profile"),
      env: { ...env, MARKET_AGENT_SERVICE: { fetch: async (request: Request) => { forwardedPath = new URL(request.url).pathname; return Response.json({ bootstrap: "required" }); } } as Fetcher },
    },
    "market-agent",
    "profile",
    { verifyAccess },
  );
  assert.equal(response.status, 200);
  assert.equal(forwardedPath, "/api/v1/private/market-agent/profile");
});

test("private Market Agent maps a registered machine identity to its delegated owner and rejects missing write scope", async () => {
  const serviceEnv: PrivateProxyEnv = {
    ...env,
    ZX_ACCESS_SERVICE_ACTORS: JSON.stringify([{
      clientId: "service-token-client-id",
      actorId: "codex-side-debug",
      ownerSubject: "debug-owner-subject",
      scopes: ["market-agent:read"],
    }]),
  };
  let forwarded: Request | undefined;
  const response = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/market-agent/profile?source=debug", { headers: { "cf-access-client-id": "service-token-client-id", "cf-access-client-secret": "client-secret" } }), env: serviceEnv },
    "market-agent",
    "profile",
    {
      verifyAccess: async () => ({ sub: "", common_name: "service-token-client-id" }) as never,
      fetcher: async (input, init) => {
        forwarded = new Request(input, init);
        return Response.json({ ok: true });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.ok(forwarded);
  const url = new URL(forwarded.url);
  const binding = createActorRequestBinding(forwarded.method, `${url.pathname}${url.search}`, await actorRequestBodyHash(forwarded));
  const actor = await verifyActorEnvelope(forwarded.headers.get("x-zx-actor"), "market-agent-only-token", { request: binding });
  assert.equal(actor.kind, "agent");
  assert.equal(actor.subject, "service:service-token-client-id");
  assert.equal(actor.ownerSubject, "debug-owner-subject");
  assert.deepEqual(actor.scopes, ["market-agent:read"]);

  let called = false;
  const denied = await proxyPrivateRequest(
    { request: new Request("https://beta.zxlab.pages.dev/api/private/market-agent/watchlist", { method: "POST", body: "{}", headers: { "cf-access-client-id": "service-token-client-id", "cf-access-client-secret": "client-secret" } }), env: serviceEnv },
    "market-agent",
    "watchlist",
    {
      verifyAccess: async () => ({ sub: "", common_name: "service-token-client-id" }) as never,
      fetcher: async () => { called = true; return Response.json({ ok: true }); },
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(called, false);
  assert.match(await denied.text(), /ACCESS_SCOPE_REQUIRED/);
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
