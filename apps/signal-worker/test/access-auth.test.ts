import { SignJWT, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { requireWriteAccess, verifyAccessJwt } from "../src/middleware/auth";

const issuer = "https://zxdx1.cloudflareaccess.com";
const audience = "its_my_first_tag_www";

function accessEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    ENVIRONMENT: "production",
    ZX_SIGNAL_ACCESS_ENABLED: "true",
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
});
