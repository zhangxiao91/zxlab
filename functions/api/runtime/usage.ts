import { fetchCodexUsage, type CodexUsageEnv } from "../../_lib/codex-usage";

interface RuntimeUsageEnv extends CodexUsageEnv { ZX_RUNTIME_SERVICE_TOKEN?: string }
interface FunctionContext { request: Request; env: RuntimeUsageEnv }

async function tokenMatches(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(provided)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
  return new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
}

export const onRequestGet = async ({ request, env }: FunctionContext) => {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = env.ZX_RUNTIME_SERVICE_TOKEN ?? "";
  if (!provided || !expected || !await tokenMatches(provided, expected)) return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  try { return Response.json(await fetchCodexUsage(env), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
  catch { return Response.json({ error: { code: "COLLECTOR_UNAVAILABLE" } }, { status: 503 }); }
};
