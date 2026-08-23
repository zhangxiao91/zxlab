import assert from "node:assert/strict";
import test from "node:test";
import { handleSignalRequest, onRequest } from "../functions/api/signal/[[path]].ts";
import type { PrivateProxyEnv } from "../functions/_lib/private-proxy.ts";

const env: PrivateProxyEnv = {
  RISK_ACCESS_TEAM_DOMAIN: "https://zxdx1.cloudflareaccess.com",
  RISK_ACCESS_AUD: "pages-audience",
  ZX_RUNTIME_SERVICE_TOKEN: "server-only-token",
};

test("the browser Signal gateway stays closed without a verified Access session", async () => {
  const response = await onRequest({
    request: new Request("https://beta.zxlab.pages.dev/api/signal/api/annotations?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        briefingId: "briefing-real",
        briefingItemId: "item-real",
        selectedText: "一段需要复核的原文",
        comment: "请验证这条判断。",
        actionType: "challenge",
      }),
    }),
    env,
    params: { path: ["api", "annotations"] },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "ACCESS_REQUIRED",
      message: "需要通过 Cloudflare Access 登录。",
    },
  });
});

test("the authenticated browser Signal gateway preserves the streaming annotation contract", async () => {
  let forwardedUrl = "";
  let forwardedMethod = "";
  let forwardedHeaders = new Headers();
  let forwardedBody = "";
  const body = JSON.stringify({
    briefingId: "briefing-real",
    briefingItemId: "item-real",
    selectedText: "一段需要复核的原文",
    comment: "请验证这条判断。",
    actionType: "challenge",
  });

  const response = await handleSignalRequest({
    request: new Request("https://beta.zxlab.pages.dev/api/signal/api/annotations?stream=1", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        cookie: "CF_Authorization=browser-session",
        "x-zx-trace-id": "browser-spoofed",
      },
      body,
    }),
    env,
    params: { path: ["api", "annotations"] },
  }, {
    verifyAccess: async () => ({ sub: "access-user-1" }) as never,
    createTraceId: () => "8e14c2bd-aec4-4970-96e6-211e9f5d6300",
    fetcher: async (input, init) => {
      forwardedUrl = String(input);
      forwardedMethod = init?.method ?? "";
      forwardedHeaders = new Headers(init?.headers);
      forwardedBody = await new Response(init?.body).text();
      return new Response('data: {"type":"start"}\n\n', {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("x-zx-trace-id"), "8e14c2bd-aec4-4970-96e6-211e9f5d6300");
  assert.equal(await response.text(), 'data: {"type":"start"}\n\n');
  assert.equal(forwardedUrl, "https://runtime-api.zx-dx.xyz/api/v1/private/signal/api/annotations?stream=1");
  assert.equal(forwardedMethod, "POST");
  assert.equal(forwardedHeaders.get("authorization"), "Bearer server-only-token");
  assert.equal(forwardedHeaders.get("accept"), "text/event-stream");
  assert.equal(forwardedHeaders.get("content-type"), "application/json");
  assert.equal(forwardedHeaders.get("x-zx-trace-id"), "8e14c2bd-aec4-4970-96e6-211e9f5d6300");
  assert.equal(forwardedHeaders.has("cookie"), false);
  assert.equal(forwardedBody, body);
});

test("the browser Signal gateway does not buffer the first SSE event", async () => {
  const encoder = new TextEncoder();
  let releaseUpstream: (() => void) | undefined;
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
      releaseUpstream = () => {
        controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
        controller.close();
      };
    },
  });
  const response = await handleSignalRequest({
    request: new Request("https://beta.zxlab.pages.dev/api/signal/api/annotations?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    env,
    params: { path: ["api", "annotations"] },
  }, {
    verifyAccess: async () => ({ sub: "access-user-1" }) as never,
    fetcher: async () => new Response(upstreamBody, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
  });

  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: {"type":"start"}\n\n');
  releaseUpstream?.();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), 'data: {"type":"done"}\n\n');
  await reader.cancel();
});
