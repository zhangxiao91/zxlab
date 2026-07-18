import { SignalError } from "../lib/errors";

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
  if (!accessAssertion || !authenticatedEmail) {
    throw new SignalError("UNAUTHORIZED", "Cloudflare Access authentication is required", 401);
  }
}
