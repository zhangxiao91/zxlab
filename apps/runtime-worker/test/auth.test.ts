import { describe, expect, it } from "vitest";
import { requireAccess } from "../src/auth";

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
});
