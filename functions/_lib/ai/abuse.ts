import type { AIEnv } from "./config.ts";
import { AIError } from "./errors.ts";

async function tokenMatches(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function originAllowed(request: Request, env: AIEnv): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const configured = env.AI_GATEWAY_ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean);
  const allowed = configured?.length ? configured : [new URL(request.url).origin];
  return allowed.includes(origin);
}

export async function enforceAIAccess(request: Request, env: AIEnv): Promise<void> {
  const expectedToken = env.AI_GATEWAY_ACCESS_TOKEN?.trim();
  const authorization = request.headers.get("authorization");
  const suppliedToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const authenticated = Boolean(expectedToken && suppliedToken && await tokenMatches(suppliedToken, expectedToken));
  const sameOrigin = originAllowed(request, env);

  if (expectedToken && !authenticated) throw new AIError("UNAUTHORIZED");
  if (!expectedToken && !sameOrigin) throw new AIError("UNAUTHORIZED");
  if (env.ENVIRONMENT === "production" && !expectedToken && !env.AI_RATE_LIMITER) {
    throw new AIError("MISSING_CONFIGURATION");
  }
  if (env.AI_RATE_LIMITER) {
    const actor = authenticated ? "authenticated" : request.headers.get("cf-connecting-ip") ?? "unknown";
    const result = await env.AI_RATE_LIMITER.limit({ key: `ai-generate:${actor}` });
    if (!result.success) throw new AIError("RATE_LIMITED");
  }
}
