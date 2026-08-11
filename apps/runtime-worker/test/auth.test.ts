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
});
