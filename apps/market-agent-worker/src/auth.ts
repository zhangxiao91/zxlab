import {
  actorRequestBodyHash,
  createActorRequestBinding,
  verifyActorEnvelope,
  type ActorEnvelopePayload,
} from "@zxlab/market-agent-schema";

export interface MarketAgentAuthEnv {
  MARKET_AGENT_PROXY_TOKEN?: string;
}

/**
 * This adapter trusts only the Pages-to-Worker transport secret, then verifies
 * the short-lived actor envelope against the exact forwarded request.
 */
export async function resolveMarketAgentActor(request: Request, env: MarketAgentAuthEnv): Promise<ActorEnvelopePayload> {
  const secret = serviceSecret(env);
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided || !await secretsMatch(provided, secret)) throw new Error("ACTOR_ENVELOPE_INVALID");
  const url = new URL(request.url);
  const requestBinding = createActorRequestBinding(
    request.method,
    `${url.pathname}${url.search}`,
    await actorRequestBodyHash(request),
  );
  return verifyActorEnvelope(request.headers.get("x-zx-actor"), secret, { request: requestBinding });
}

export function requireMarketAgentScope(actor: ActorEnvelopePayload, method: string): void {
  const required = `market-agent:${isReadMethod(method) ? "read" : "write"}`;
  if (!hasScope(actor.scopes, required)) throw new Error("ACTOR_SCOPE_REQUIRED");
}

function serviceSecret(env: MarketAgentAuthEnv): string {
  const secret = env.MARKET_AGENT_PROXY_TOKEN?.trim();
  if (!secret) throw new Error("ACTOR_ENVELOPE_MISSING");
  return secret;
}

function isReadMethod(method: string): boolean {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes("*") || scopes.includes(required)) return true;
  const separator = required.indexOf(":");
  return separator > 0 && scopes.includes(`${required.slice(0, separator)}:*`);
}

async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
