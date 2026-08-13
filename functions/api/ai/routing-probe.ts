import type { AIEnv } from "../../_lib/ai/config.ts";
import { routeProbe } from "../../_lib/ai/router.ts";

interface FunctionContext { request: Request; env: AIEnv }

export async function onRequest(context: FunctionContext): Promise<Response> {
  if (context.request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  return Response.json(routeProbe("market-agent-close-review", context.env), {
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
