import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRequestArguments,
  performDebugRequest,
  readDebugAccessCredentials,
} from "./zxlab-debug-request.mjs";

test("debug request is pinned to the dedicated Access origin", () => {
  const request = parseRequestArguments(["--path", "/api/private/market-agent/profile?source=codex"]);
  assert.equal(request.url.href, "https://debug-beta.zxlab.pages.dev/api/private/market-agent/profile?source=codex");
  assert.throws(() => parseRequestArguments(["--path", "https://example.com/api/private/market-agent/profile"]), /Path must stay/);
  assert.throws(() => parseRequestArguments(["--path", "/api/private/signal/api/admin"]), /Path must stay/);
});

test("debug request validates JSON bodies before credentials are used", () => {
  assert.throws(() => parseRequestArguments(["--method", "POST", "--body", "not-json"]), SyntaxError);
  assert.throws(() => parseRequestArguments(["--method", "GET", "--body", "{}"]), /cannot include/);
});

test("credentials are read from fixed Keychain services", () => {
  const requested = [];
  const credentials = readDebugAccessCredentials((service) => {
    requested.push(service);
    return service.endsWith("client-id") ? "client-id\n" : "client-secret\n";
  });
  assert.deepEqual(requested, ["zxlab.debug-access.client-id", "zxlab.debug-access.client-secret"]);
  assert.deepEqual(credentials, { clientId: "client-id", clientSecret: "client-secret" });
});

test("request sends credentials only to the pinned origin and never follows redirects", async () => {
  let observed;
  const request = parseRequestArguments([]);
  const result = await performDebugRequest(request, { clientId: "client-id", clientSecret: "client-secret" }, async (url, init) => {
    observed = { url: String(url), init };
    return new Response("redirected", { status: 302, headers: { location: "https://login.example.test/" } });
  });
  assert.equal(observed.url, "https://debug-beta.zxlab.pages.dev/api/private/market-agent/profile");
  assert.equal(observed.init.redirect, "manual");
  assert.equal(observed.init.headers["CF-Access-Client-Id"], "client-id");
  assert.equal(observed.init.headers["CF-Access-Client-Secret"], "client-secret");
  assert.deepEqual(result, { status: 302, location: "https://login.example.test/", body: "redirected" });
});

