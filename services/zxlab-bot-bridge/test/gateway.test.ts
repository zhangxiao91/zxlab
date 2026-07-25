import test from "node:test";
import assert from "node:assert/strict";
import { runGatewayTask } from "../src/gateway.js";

const input = {
  task: "portfolio-review",
  messages: [{ role: "user" as const, content: "review" }],
  responseFormat: { type: "json" as const },
};

test("uses terminal stream result as authoritative output", async () => {
  const result = await runGatewayTask({
    baseUrl: "https://gateway.example",
    token: "server-only",
    timeoutMs: 1_000,
    fetcher: async (request, init) => {
      assert.equal(String(request), "https://gateway.example/api/ai/stream");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer server-only");
      return new Response([
        'event: delta\ndata: {"type":"delta","requestId":"r1","text":"partial"}',
        'event: reset\ndata: {"type":"reset","requestId":"r1","reason":"fallback"}',
        'event: done\ndata: {"type":"done","requestId":"r1","data":{"text":"{\\"ok\\":true}","json":{"ok":true},"provider":"p2","model":"m2","fallbackIndex":1,"latencyMs":50}}',
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    },
  }, input);
  assert.equal(result.transport, "stream");
  assert.deepEqual(result.json, { ok: true });
  assert.equal(result.provider, "p2");
});

test("falls back to generate only for stream transport incompatibility", async () => {
  const calls: string[] = [];
  const result = await runGatewayTask({
    baseUrl: "https://gateway.example",
    token: "server-only",
    timeoutMs: 1_000,
    fetcher: async (request) => {
      calls.push(String(request));
      if (String(request).endsWith("/stream")) {
        return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
      }
      return Response.json({
        ok: true,
        requestId: "r2",
        data: { text: "fallback", provider: "p1", model: "m1", fallbackIndex: 0, latencyMs: 20 },
      });
    },
  }, input);
  assert.equal(result.transport, "generate-fallback");
  assert.deepEqual(calls, [
    "https://gateway.example/api/ai/stream",
    "https://gateway.example/api/ai/generate",
  ]);
});

test("does not hide a model error behind generate fallback", async () => {
  let calls = 0;
  await assert.rejects(() => runGatewayTask({
    baseUrl: "https://gateway.example",
    token: "server-only",
    timeoutMs: 1_000,
    fetcher: async () => {
      calls += 1;
      return new Response('event: error\ndata: {"type":"error","requestId":"r3","error":{"code":"ALL_CANDIDATES_FAILED","message":"unavailable"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  }, input), /unavailable/);
  assert.equal(calls, 1);
});
