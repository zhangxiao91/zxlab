import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/api/signal/[[path]].ts";
import type { PrivateProxyEnv } from "../functions/_lib/private-proxy.ts";

const env: PrivateProxyEnv = {
  RISK_ACCESS_TEAM_DOMAIN: "https://zxdx1.cloudflareaccess.com",
  RISK_ACCESS_AUD: "pages-audience",
  ZX_RUNTIME_SERVICE_TOKEN: "server-only-token",
};

test("the browser Signal gateway stays closed without a verified Access session", async () => {
  const response = await onRequest({
    request: new Request("https://beta.zxlab.pages.dev/api/signal/api/watches"),
    env,
    params: { path: ["api", "watches"] },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "ACCESS_REQUIRED",
      message: "需要通过 Cloudflare Access 登录。",
    },
  });
});
