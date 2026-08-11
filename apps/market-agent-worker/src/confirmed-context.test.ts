import assert from "node:assert/strict";
import test from "node:test";
import { canonicalMemoryRevisionHash, SignalMemoryAdapter } from "./confirmed-context.ts";

function memory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "memory-1",
    namespace: "markets",
    kind: "preference",
    content: "只关注有明确催化剂的市场变化。",
    importance: 0.8,
    confidence: 0.9,
    sourceType: "market-agent-preference",
    sourceId: null,
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

test("retrieves only allowlisted confirmed context and never returns Signal summary text", async () => {
  const item = memory();
  const revisionHash = await canonicalMemoryRevisionHash(item);
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new SignalMemoryAdapter({
    token: "runtime-secret",
    fetcher: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      assert.equal(request.headers.get("authorization"), "Bearer runtime-secret");
      requestBody = JSON.parse(await request.clone().text()) as Record<string, unknown>;
      return new Response(JSON.stringify({ memories: [
        { ...item, revisionHash },
        { ...item, id: "ignored", kind: "summary", sourceType: "legacy" },
      ], summary: "private summary must not be passed through" }), { status: 200 });
    },
  });

  const result = await adapter.retrieve({ profileId: "profile-1", workflow: "ask", instrumentIds: ["SSE:600000"] });
  assert.equal(result.contexts.length, 1);
  assert.equal(result.contexts[0]?.content, item.content);
  assert.equal(result.contexts[0]?.role, "preference");
  assert.equal(requestBody?.task, "market-agent:ask");
  assert.deepEqual(requestBody?.namespaces, ["markets", "global"]);
  assert.equal("summary" in result, false);
});

test("rejects a canonical context when its revision hash does not verify", async () => {
  const adapter = new SignalMemoryAdapter({
    baseUrl: "https://signal.example",
    fetcher: async () => new Response(JSON.stringify({ memories: [{ ...memory(), revisionHash: "sha256:" + "0".repeat(64) }] }), { status: 200 }),
  });
  const result = await adapter.retrieve({ profileId: "profile-1", workflow: "close_review", instrumentIds: ["SSE:600000"] });
  assert.equal(result.contexts.length, 0);
  assert.ok(result.limitations.some((item) => item.includes("revision hash")));
});
