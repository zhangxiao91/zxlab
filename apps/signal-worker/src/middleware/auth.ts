import { SignalError } from "../lib/errors";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function accessIssuer(env: Env): string {
  const value = String(env.CF_ACCESS_TEAM_DOMAIN).trim().replace(/\/$/, "");
  if (!value.startsWith("https://")) throw new SignalError("UNAUTHORIZED", "Cloudflare Access issuer is invalid", 401);
  return value;
}

function remoteKeySet(issuer: string): JWTVerifyGetKey {
  const existing = remoteKeySets.get(issuer);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  remoteKeySets.set(issuer, created);
  return created;
}

export async function verifyAccessJwt(token: string, env: Env, key?: CryptoKey): Promise<string> {
  const issuer = accessIssuer(env);
  const audience = String(env.CF_ACCESS_AUD).trim();
  if (!audience) throw new SignalError("UNAUTHORIZED", "Cloudflare Access audience is missing", 401);
  try {
    const { payload } = key
      ? await jwtVerify(token, key, { issuer, audience })
      : await jwtVerify(token, remoteKeySet(issuer), { issuer, audience });
    if (typeof payload.email !== "string" || !payload.email.trim()) throw new Error("Access token email is missing");
    return payload.email.trim().toLowerCase();
  } catch (cause) {
    throw new SignalError("UNAUTHORIZED", "Cloudflare Access token validation failed", 401, cause);
  }
}

async function safeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function requireWriteAccess(request: Request, env: Env): Promise<void> {
  if (String(env.ENVIRONMENT) === "development") {
    const authorization = request.headers.get("authorization") ?? "";
    const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (provided && await safeEqual(provided, env.ZX_SIGNAL_WRITE_TOKEN)) return;
    throw new SignalError("UNAUTHORIZED", "A valid local development write token is required", 401);
  }

  if (String(env.ZX_SIGNAL_ACCESS_ENABLED) !== "true") {
    throw new SignalError("UNAUTHORIZED", "Signal writes are disabled until Cloudflare Access is configured", 401);
  }

  const accessAssertion = request.headers.get("cf-access-jwt-assertion");
  const authenticatedEmail = request.headers.get("cf-access-authenticated-user-email");
  if (!accessAssertion) throw new SignalError("UNAUTHORIZED", "Cloudflare Access authentication is required", 401);
  const tokenEmail = await verifyAccessJwt(accessAssertion, env);
  if (authenticatedEmail && authenticatedEmail.trim().toLowerCase() !== tokenEmail) {
    throw new SignalError("UNAUTHORIZED", "Cloudflare Access identity headers did not match", 401);
  }
}
