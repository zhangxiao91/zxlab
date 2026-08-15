import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { completePrivateAccess } from "../functions/api/private/session.ts";
import { RiskReviewError, type RiskReviewEnv } from "../functions/_lib/risk/review.ts";

const env: RiskReviewEnv = {
  RISK_ACCESS_TEAM_DOMAIN: "https://zxdx1.cloudflareaccess.com",
  RISK_ACCESS_AUD: "pages-audience",
};

test("private access callback verifies Access before notifying the briefing", async () => {
  const response = await completePrivateAccess(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/session?returnTo=/briefing/"),
      env,
    },
    { verifyAccess: async () => ({ sub: "access-user-1" }) as never },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.text();
  assert.match(body, /new BroadcastChannel\("zxlab-private-access"\)/);
  assert.match(body, /window\.opener\.postMessage/);
  assert.match(body, /zxlab:private-access-ready/);
  assert.match(body, /window\.close\(\)/);
  assert.match(body, /href="\/briefing\/"/);
  assert.match(body, /fetch\("\/api\/signal\/api\/watches"/);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
});

test("private access callback waits for a successful Signal probe before notifying and closing", async () => {
  const response = await completePrivateAccess(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/session?returnTo=/briefing/"),
      env,
    },
    { verifyAccess: async () => ({ sub: "access-user-1" }) as never },
  );
  const body = await response.text();
  const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  let closed = false;
  let redirectedTo = "";
  const openerMessages: unknown[] = [];
  const fetchCalls: Array<{ url: string; credentials?: RequestCredentials; redirect?: RequestRedirect }> = [];
  const statusElement = { dataset: {} as Record<string, string>, textContent: "" };
  vm.runInNewContext(script, {
    BroadcastChannel: undefined,
    document: { querySelector: () => statusElement },
    fetch: async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, credentials: init?.credentials, redirect: init?.redirect });
      return new Response(null, { status: 200 });
    },
    window: {
      close: () => { closed = true; },
      opener: { closed: false, postMessage: (value: unknown) => openerMessages.push(value) },
      location: { origin: "https://beta.zxlab.pages.dev", replace: (value: string) => { redirectedTo = value; } },
      setTimeout: (callback: () => void) => callback(),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fetchCalls, [{
    url: "/api/signal/api/watches",
    credentials: "include",
    redirect: "manual",
  }]);
  assert.equal(closed, true);
  assert.equal(redirectedTo, "/briefing/");
  assert.equal(openerMessages.length, 1);
  assert.equal((openerMessages[0] as { type?: string }).type, "zxlab:private-access-ready");
});

test("private access callback verifies the Market Agent session for Market recovery", async () => {
  const response = await completePrivateAccess(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/session?service=market-agent&returnTo=/lab/trading/?view=review%26mode=market"),
      env,
    },
    { verifyAccess: async () => ({ sub: "access-user-1" }) as never },
  );
  const body = await response.text();

  assert.match(body, /正在确认 Market Agent 私有会话/);
  assert.match(body, /fetch\("\/api\/private\/market-agent\/profile"/);
  assert.doesNotMatch(body, /Signal 私有会话尚未可用/);
});

test("private access callback does not report success when the Signal probe is not ready", async () => {
  const response = await completePrivateAccess(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/session?returnTo=/briefing/"),
      env,
    },
    { verifyAccess: async () => ({ sub: "access-user-1" }) as never },
  );
  const body = await response.text();
  const script = body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  let closed = false;
  const openerMessages: unknown[] = [];
  const statusElement = { dataset: {} as Record<string, string>, textContent: "" };
  vm.runInNewContext(script, {
    BroadcastChannel: undefined,
    document: { querySelector: () => statusElement },
    fetch: async () => new Response(null, { status: 302 }),
    window: {
      close: () => { closed = true; },
      opener: { closed: false, postMessage: (value: unknown) => openerMessages.push(value) },
      location: { origin: "https://beta.zxlab.pages.dev", replace: () => undefined },
      setTimeout: () => undefined,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed, false);
  assert.equal(openerMessages.length, 0);
  assert.equal(statusElement.dataset.state, "waiting");
  assert.match(statusElement.textContent, /Signal 私有会话尚未可用/);
  assert.match(body, /data-private-access-status/);
});

test("private access callback rejects unverified sessions without a success signal", async () => {
  const response = await completePrivateAccess(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/session?returnTo=/briefing/"),
      env,
    },
    {
      verifyAccess: async () => {
        throw new RiskReviewError("ACCESS_REQUIRED", "需要通过 Cloudflare Access 登录。", 401);
      },
    },
  );

  assert.equal(response.status, 401);
  const body = await response.text();
  assert.doesNotMatch(body, /zxlab:private-access-ready/);
  assert.match(body, /统一授权暂时无法确认/);
});

test("private access callback never redirects to another origin", async () => {
  const response = await completePrivateAccess(
    {
      request: new Request("https://beta.zxlab.pages.dev/api/private/session?returnTo=https://evil.example/steal"),
      env,
    },
    { verifyAccess: async () => ({ sub: "access-user-1" }) as never },
  );

  const body = await response.text();
  assert.match(body, /href="\/"/);
  assert.doesNotMatch(body, /evil\.example/);
});

test("Status reuses the same protected access callback", async () => {
  const source = await readFile(new URL("../src/pages/status.astro", import.meta.url), "utf8");

  assert.match(source, /probe: "\/api\/private\/session\?returnTo=\/status\/"/);
  assert.match(source, /login: "\/api\/private\/session\?returnTo=\/status\/"/);
  assert.doesNotMatch(source, /pages: \{ probe: "\/lab\/risk\//);
});
