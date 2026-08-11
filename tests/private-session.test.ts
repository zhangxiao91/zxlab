import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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
  assert.match(body, /zxlab:private-access-ready/);
  assert.match(body, /window\.close\(\)/);
  assert.match(body, /href="\/briefing\/"/);
  assert.doesNotMatch(body, /api\/watches|"watches"/);
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
