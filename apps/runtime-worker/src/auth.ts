import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function requireAccess(request: Request, env: Env) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Cloudflare Access authentication is required." } }), { status: 401 });
  const issuer = env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  let keys = keySets.get(issuer);
  if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keySets.set(issuer, keys); }
  try { await jwtVerify(token, keys, { issuer, audience: env.CF_ACCESS_AUD }); }
  catch { throw new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Cloudflare Access token validation failed." } }), { status: 401 }); }
}
