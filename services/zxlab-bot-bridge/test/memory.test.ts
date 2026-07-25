import test from "node:test";
import assert from "node:assert/strict";
import { saveConfirmedMemory, searchCanonicalMemory } from "../src/memory.js";

test("keeps canonical Memory credentials in bridge request headers", async () => {
  const result = await searchCanonicalMemory({
    baseUrl: "https://memory.example",
    token: "memory-token",
    accessClientId: "access-id",
    accessClientSecret: "access-secret",
    timeoutMs: 1_000,
    fetcher: async (request, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer memory-token");
      assert.equal(headers.get("cf-access-client-id"), "access-id");
      assert.equal(headers.get("cf-access-client-secret"), "access-secret");
      assert.equal(String(request), "https://memory.example/api/memory/retrieve");
      return Response.json({ memories: [], summary: "", tokenEstimate: 0 });
    },
  }, { task: "wechat-assistant", namespaces: ["zxlab"], query: "规则", limit: 12, tokenBudget: 1_500 });
  assert.deepEqual(result.memories, []);
});

test("writes through canonical API with confirmed source type", async () => {
  const memory = await saveConfirmedMemory({
    baseUrl: "https://memory.example",
    token: "memory-token",
    timeoutMs: 1_000,
    fetcher: async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.sourceType, "wechat-confirmed");
      assert.equal(body.content, "规则内容");
      return Response.json({ memory: { id: "m1", ...body } }, { status: 201 });
    },
  }, {
    namespace: "zxlab",
    kind: "rule",
    content: "规则内容",
    importance: 0.8,
    confidence: 1,
  });
  assert.equal(memory.id, "m1");
});
