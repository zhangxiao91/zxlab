import assert from "node:assert/strict";
import test from "node:test";
import { SignalApiError, submitAnnotationStream } from "../src/features/briefing/client.ts";
import type { AnnotationInput } from "../src/features/briefing/types.ts";

const input: AnnotationInput = {
  briefingId: "briefing-real",
  briefingItemId: "item-real",
  selectedText: "一段需要复核的原文",
  comment: "请验证这条判断。",
  action: "challenge",
};
const idempotencyKey = "5cab3051-247e-47b9-b90a-630a1a5b8067";

const response = {
  annotation: {
    id: "annotation-1",
    briefingId: input.briefingId,
    briefingItemId: input.briefingItemId,
    selectedText: input.selectedText,
    comment: input.comment,
    action: input.action,
    createdAt: "2026-08-13T10:30:00.000Z",
  },
  reply: {
    id: "reply-1",
    annotationId: "annotation-1",
    content: "已收到并完成复核。",
    createdAt: "2026-08-13T10:30:01.000Z",
    model: "test-signal",
  },
};

test("streaming annotations use the complete authenticated browser request contract", async (context) => {
  let call: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  context.mock.method(globalThis, "fetch", async (fetchInput, init) => {
    call = { input: fetchInput, init };
    const encoder = new TextEncoder();
    const done = `data: ${JSON.stringify({ type: "done", response })}`;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"start"}\n\ndata: {"type":"reply_delta","text":"已'));
        controller.enqueue(encoder.encode('收到"}\n\n'));
        controller.enqueue(encoder.encode(done));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  });

  const events = [];
  for await (const event of submitAnnotationStream(input, idempotencyKey)) events.push(event);

  assert.equal(String(call?.input), "/api/signal/api/annotations?stream=1");
  assert.equal(call?.init?.method, "POST");
  assert.equal(call?.init?.credentials, "include");
  assert.equal(call?.init?.redirect, "manual");
  const requestHeaders = new Headers(call?.init?.headers);
  assert.equal(requestHeaders.get("content-type"), "application/json");
  assert.equal(requestHeaders.has("x-request-id"), false);
  assert.match(requestHeaders.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/i);
  assert.deepEqual(JSON.parse(String(call?.init?.body)), { ...input, actionType: "challenge" });
  assert.deepEqual(events, [
    { type: "start" },
    { type: "reply_delta", text: "已收到" },
    { type: "done", response },
  ]);
});

test("a failed stream falls back to the non-stream annotation contract", async (context) => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  context.mock.method(globalThis, "fetch", async (fetchInput, init) => {
    calls.push({ input: fetchInput, init });
    if (calls.length === 1) throw new TypeError("Failed to fetch");
    return Response.json(response);
  });

  const events = [];
  for await (const event of submitAnnotationStream(input, idempotencyKey)) events.push(event);

  assert.equal(calls.length, 2);
  assert.equal(String(calls[1]?.input), "/api/signal/api/annotations");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.equal(calls[1]?.init?.credentials, "include");
  assert.equal(calls[1]?.init?.redirect, "manual");
  const streamHeaders = new Headers(calls[0]?.init?.headers);
  const fallbackHeaders = new Headers(calls[1]?.init?.headers);
  assert.equal(fallbackHeaders.get("content-type"), "application/json");
  assert.match(streamHeaders.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(fallbackHeaders.get("idempotency-key"), streamHeaders.get("idempotency-key"));
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { ...input, actionType: "challenge" });
  assert.deepEqual(events, [{ type: "done", response }]);
});

test("generic network failures remain network failures instead of being reported as Access failures", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(async () => {
    for await (const event of submitAnnotationStream(input, idempotencyKey)) void event;
  }, (error: unknown) => {
    assert.ok(error instanceof SignalApiError);
    assert.equal(error.code, "SIGNAL_API_UNAVAILABLE");
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /Access|授权/);
    return true;
  });
});

test("explicit Access failures stay distinct from network failures", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: "ACCESS_REQUIRED", message: "需要通过 Cloudflare Access 登录。" },
  }, { status: 401 }));

  await assert.rejects(async () => {
    for await (const event of submitAnnotationStream(input, idempotencyKey)) void event;
  }, (error: unknown) => {
    assert.ok(error instanceof SignalApiError);
    assert.equal(error.code, "ACCESS_REQUIRED");
    assert.equal(error.status, 401);
    return true;
  });
});

test("an SSE error frame remains a send failure instead of an Access failure", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    'data: {"type":"error","error":{"message":"Signal annotation failed"}}',
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  ));

  const events = [];
  for await (const event of submitAnnotationStream(input, idempotencyKey)) events.push(event);
  assert.deepEqual(events, [{ type: "error", error: { message: "Signal annotation failed" } }]);
});
