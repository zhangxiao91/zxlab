import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet } from "../functions/api/status.ts";

const runtimeSnapshot = {
  schemaVersion: "1",
  overall: {
    status: "operational",
    summary: "All monitored services are healthy.",
    stale: false,
    counts: { operational: 3, degraded: 0, offline: 0, unknown: 0, total: 3 },
  },
  modules: [],
  activities: [],
  generatedAt: "2026-07-27T00:00:00.000Z",
};

test("status API proxies the Runtime Worker public snapshot", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json(runtimeSnapshot);
  };

  const response = await onRequestGet({
    request: new Request("https://zx-dx.xyz/api/status"),
    env: { RUNTIME_API_URL: "https://runtime.example" },
  });

  assert.equal(response.status, 200);
  assert.equal(requestedUrl, "https://runtime.example/api/v1/public/status");
  assert.deepEqual(await response.json(), runtimeSnapshot);
  assert.equal(response.headers.get("cache-control"), "public, max-age=15, s-maxage=30");
});

test("status API returns 503 when the Runtime Worker is unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("unavailable"); };

  const response = await onRequestGet({
    request: new Request("https://zx-dx.xyz/api/status"),
    env: {},
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "RUNTIME_UNAVAILABLE",
      message: "Runtime status is temporarily unavailable.",
    },
  });
});
