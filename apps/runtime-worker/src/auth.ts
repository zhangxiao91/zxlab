import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function serviceTokenValid(request: Request, expected: string): Promise<boolean> {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return difference === 0;
}

export async function requireAccess(request: Request, env: Env) {
  if (await serviceTokenValid(request, env.ZX_RUNTIME_SERVICE_TOKEN)) return;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Cloudflare Access authentication is required." } }), { status: 401 });
  const issuer = env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  let keys = keySets.get(issuer);
  if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keySets.set(issuer, keys); }
  try { await jwtVerify(token, keys, { issuer, audience: env.CF_ACCESS_AUD }); }
  catch { throw new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Cloudflare Access token validation failed." } }), { status: 401 }); }
}
