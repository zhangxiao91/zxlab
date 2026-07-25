import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet } from "../functions/api/status.ts";

test("status API uses truthful unavailable modules instead of demo providers", async () => {
  const response = await onRequestGet({
    request: new Request("https://zx-dx.xyz/api/status"),
    env: {
      CF_PAGES_BRANCH: "beta",
      CF_PAGES_COMMIT_SHA: "1234567890abcdef",
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.overview.status, "operational");
  assert.deepEqual(payload.modules.map((module: { id: string }) => module.id), [
    "remote-agents",
    "memory",
    "runtime",
  ]);
  assert.equal(payload.modules[0].status, "unknown");
  assert.equal(payload.modules[0].details.agents.length, 0);
  assert.equal(payload.modules[1].status, "unknown");
  assert.equal(payload.modules[1].details.memory.lastError, "Live source unavailable.");
  assert.equal(payload.modules[2].status, "operational");
  assert.equal(payload.modules[2].metrics[0].value, "1234567");
  assert.equal(payload.modules[2].details.runtime.services.length, 2);
  assert.equal(payload.activities.length, 1);
  assert.equal(payload.activities[0].title, "Unified Status API responded successfully");

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("macbook-neo"), false);
  assert.equal(serialized.includes("2486"), false);
  assert.equal(serialized.includes("99.96"), false);
});
