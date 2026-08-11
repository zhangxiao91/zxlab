import { SignJWT, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { corsHeaders } from "../src/lib/http";
import { requireWriteAccess, verifyAccessJwt } from "../src/middleware/auth";
import signalWorker from "../src/index";

const issuer = "https://zxdx1.cloudflareaccess.com";
const audience = "its_my_first_tag_www";

function accessEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    ENVIRONMENT: "production",
    ZX_SIGNAL_ACCESS_ENABLED: "true",
    ZX_SIGNAL_ALLOWED_ORIGINS: "",
    CF_ACCESS_TEAM_DOMAIN: issuer,
    CF_ACCESS_AUD: audience,
    ...overrides,
  } as unknown as Env;
}

async function accessToken(input: { audience?: string; email?: string } = {}): Promise<{ token: string; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({ email: input.email ?? "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "access-test" })
    .setIssuer(issuer)
    .setAudience(input.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { token, publicKey };
}

describe("Cloudflare Access authentication", () => {
  it("validates signature, issuer, audience and email", async () => {
    const { token, publicKey } = await accessToken();
    await expect(verifyAccessJwt(token, accessEnv(), publicKey)).resolves.toBe("owner@example.com");
  });

  it("rejects a token issued for another Access application", async () => {
    const { token, publicKey } = await accessToken({ audience: "another-app" });
    await expect(verifyAccessJwt(token, accessEnv(), publicKey)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("fails closed before JWT verification when production writes are disabled", async () => {
    const request = new Request("https://signal.example/api/annotations", { method: "POST" });
    await expect(requireWriteAccess(request, accessEnv({ ZX_SIGNAL_ACCESS_ENABLED: "false" })))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows the dedicated bridge token only on the two canonical Memory routes", async () => {
    const env = accessEnv({ ZX_MEMORY_BRIDGE_TOKEN: "memory-bridge-secret" });
    const headers = { authorization: "Bearer memory-bridge-secret" };
    await expect(requireWriteAccess(
      new Request("https://signal.example/api/memory/retrieve", { method: "POST", headers }),
      env,
    )).resolves.toBeUndefined();
    await expect(requireWriteAccess(
      new Request("https://signal.example/api/memory/items", { method: "POST", headers }),
      env,
    )).resolves.toBeUndefined();
    await expect(requireWriteAccess(
      new Request("https://signal.example/api/annotations", { method: "POST", headers }),
      env,
    )).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireWriteAccess(
      new Request("https://signal.example/api/memory/consolidate", { method: "POST", headers }),
      env,
    )).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows the Runtime service token across protected service-binding routes", async () => {
    const env = accessEnv({ ZX_RUNTIME_SERVICE_TOKEN: "runtime-service-secret" });
    const headers = { authorization: "Bearer runtime-service-secret" };
    await expect(requireWriteAccess(new Request("https://signal.example/api/annotations", { method: "POST", headers }), env)).resolves.toBeUndefined();
    await expect(requireWriteAccess(new Request("https://signal.example/api/memory/consolidate", { method: "POST", headers }), env)).resolves.toBeUndefined();
  });

  it("rejects unauthenticated Watch reads and writes at the Worker seam", async () => {
    const disabled = accessEnv({ ZX_SIGNAL_ACCESS_ENABLED: "false" });
    const read = await signalWorker.fetch(new Request("https://signal.example/api/watches"), disabled);
    const write = await signalWorker.fetch(new Request("https://signal.example/api/watches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ briefingId: "briefing", briefingItemId: "item", condition: "Track it." }),
    }), disabled);
    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
  });

  it("allows the annotation stream accept header in CORS preflight", () => {
    const request = new Request("https://signal.example/api/annotations", {
      method: "OPTIONS",
      headers: { origin: "https://beta.zxlab.pages.dev" },
    });
    const headers = corsHeaders(request, accessEnv({ ZX_SIGNAL_ALLOWED_ORIGINS: "https://*.zxlab.pages.dev" }));
    expect(headers.get("access-control-allow-origin")).toBe("https://beta.zxlab.pages.dev");
    expect(headers.get("access-control-allow-headers")).toContain("accept");
  });

  it("does not treat the preview wildcard as an arbitrary Pages origin", () => {
    const request = new Request("https://signal.example/api/annotations", {
      method: "OPTIONS",
      headers: { origin: "https://other.pages.dev" },
    });
    const headers = corsHeaders(request, accessEnv({ ZX_SIGNAL_ALLOWED_ORIGINS: "https://*.zxlab.pages.dev" }));
    expect(headers.has("access-control-allow-origin")).toBe(false);
  });
});
