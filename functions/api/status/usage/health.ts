import { fetchCodexHealth } from "../../../_lib/codex-usage";
import type { CodexUsageEnv } from "../../../_lib/codex-usage";

interface FunctionContext { env: CodexUsageEnv; }

export const onRequestGet = async ({ env }: FunctionContext) => {
  try {
    const payload = await fetchCodexHealth(env);
    return Response.json(payload, { headers: { "Cache-Control": "public, max-age=15, s-maxage=30" } });
  } catch {
    return Response.json(
      { status: "offline", appServer: "unknown", lastSuccessAt: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
