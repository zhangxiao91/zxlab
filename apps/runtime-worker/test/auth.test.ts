import { describe, expect, it } from "vitest";
import { requireAccess } from "../src/auth";
import runtimeWorker from "../src/index";

const env = { ZX_RUNTIME_SERVICE_TOKEN: "runtime-service-secret" } as Env;

describe("Runtime private authentication", () => {
  it("accepts the server-only Runtime service token", async () => {
    const request = new Request("https://runtime.example/api/v1/private/overview", {
      headers: { authorization: "Bearer runtime-service-secret" },
    });
    await expect(requireAccess(request, env)).resolves.toBeUndefined();
  });

  it("rejects a missing browser Access assertion", async () => {
    await expect(requireAccess(new Request("https://runtime.example/api/v1/private/overview"), env))
      .rejects.toMatchObject({ status: 401 });
  });

  it("forwards Watch lifecycle routes through the bounded Signal bridge", async () => {
    let forwarded: { url: string; method?: string; authorization: string | null } | undefined;
    const runtimeEnv = {
      ZX_RUNTIME_SERVICE_TOKEN: "runtime-service-secret",
      RUNTIME_ALLOWED_ORIGINS: "https://beta.zxlab.pages.dev",
      DB: {} as D1Database,
      SIGNAL: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          forwarded = {
            url: String(input),
            method: init?.method,
            authorization: new Headers(init?.headers).get("authorization"),
          };
          return Response.json({ watch: { id: "watch-1" } });
        },
      },
    } as unknown as Env;
    const response = await runtimeWorker.fetch!(new Request(
      "https://runtime.example/api/v1/private/signal/api/watches/watch-1/resolve",
      {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-service-secret",
          "content-type": "application/json",
        },
        body: "{}",
      },
    ), runtimeEnv);

    expect(response.status).toBe(200);
    expect(forwarded).toEqual({
      url: "https://signal.internal/api/watches/watch-1/resolve",
      method: "POST",
      authorization: "Bearer runtime-service-secret",
    });

    for (const request of [
      new Request("https://runtime.example/api/v1/private/signal/api/watches/watch-1", {
        headers: { authorization: "Bearer runtime-service-secret" },
      }),
      new Request("https://runtime.example/api/v1/private/signal/api/watches/watch-1/resolve", {
        headers: { authorization: "Bearer runtime-service-secret" },
      }),
      new Request("https://runtime.example/api/v1/private/signal/api/watches/watch-1/resolve/again", {
        method: "POST",
        headers: { authorization: "Bearer runtime-service-secret" },
        body: "{}",
      }),
    ]) {
      expect((await runtimeWorker.fetch!(request, runtimeEnv)).status).toBe(404);
    }
  });

  it("preserves the streaming annotation contract across the Signal bridge", async () => {
    let forwarded: {
      url: string;
      method?: string;
      authorization: string | null;
      accept: string | null;
      contentType: string | null;
      idempotencyKey: string | null;
      traceId: string | null;
      body: string;
    } | undefined;
    const body = JSON.stringify({
      briefingId: "briefing-real",
      briefingItemId: "item-real",
      selectedText: "一段需要复核的原文",
      comment: "请验证这条判断。",
      actionType: "challenge",
    });
    const runtimeEnv = {
      ZX_RUNTIME_SERVICE_TOKEN: "runtime-service-secret",
      RUNTIME_ALLOWED_ORIGINS: "https://beta.zxlab.pages.dev",
      DB: {} as D1Database,
      SIGNAL: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          forwarded = {
            url: String(input),
            method: init?.method,
            authorization: headers.get("authorization"),
            accept: headers.get("accept"),
            contentType: headers.get("content-type"),
            idempotencyKey: headers.get("idempotency-key"),
            traceId: headers.get("x-zx-trace-id"),
            body: await new Response(init?.body).text(),
          };
          return new Response('data: {"type":"start"}\n\n', {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          });
        },
      },
    } as unknown as Env;

    const response = await runtimeWorker.fetch!(new Request(
      "https://runtime.example/api/v1/private/signal/api/annotations?stream=1",
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer runtime-service-secret",
          "content-type": "application/json",
          "idempotency-key": "5cab3051-247e-47b9-b90a-630a1a5b8067",
          "x-zx-trace-id": "8e14c2bd-aec4-4970-96e6-211e9f5d6300",
        },
        body,
      },
    ), runtimeEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-zx-trace-id")).toBe("8e14c2bd-aec4-4970-96e6-211e9f5d6300");
    expect(await response.text()).toBe('data: {"type":"start"}\n\n');
    expect(forwarded).toEqual({
      url: "https://signal.internal/api/annotations?stream=1",
      method: "POST",
      authorization: "Bearer runtime-service-secret",
      accept: "text/event-stream",
      contentType: "application/json",
      idempotencyKey: "5cab3051-247e-47b9-b90a-630a1a5b8067",
      traceId: "8e14c2bd-aec4-4970-96e6-211e9f5d6300",
      body,
    });
  });
});
