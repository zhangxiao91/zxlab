import { verifyCloudflareAccess, type RiskReviewEnv } from "../../_lib/risk/review.ts";
import type { LLMUsageDatabase } from "../../_lib/ai/telemetry.ts";
import { getLLMUsageDashboard, parseRange } from "../../_lib/ai/usage-repository.ts";

interface StatusLLMEnv extends RiskReviewEnv { LLM_USAGE_DB?: LLMUsageDatabase; STATUS_LLM_ACCESS_TEAM_DOMAIN?: string; STATUS_LLM_ACCESS_AUD?: string }
interface FunctionContext { request: Request; env: StatusLLMEnv }
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });

/** Detailed usage is never a public Status source: Cloudflare Access is required. */
export async function onRequestGet(context: FunctionContext): Promise<Response> {
  if (!context.env.LLM_USAGE_DB) return json({ error: "LLM_USAGE_UNAVAILABLE", message: "LLM usage data is temporarily unavailable." }, 503);
  try {
    await verifyCloudflareAccess(context.request, {
      ...context.env,
      RISK_ACCESS_TEAM_DOMAIN: context.env.STATUS_LLM_ACCESS_TEAM_DOMAIN,
      RISK_ACCESS_AUD: context.env.STATUS_LLM_ACCESS_AUD,
    });
    return json(await getLLMUsageDashboard(context.env.LLM_USAGE_DB, parseRange(new URL(context.request.url).searchParams.get("range"))));
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error && typeof error.status === "number" ? error.status : 503;
    return json({ error: status === 401 || status === 403 ? "ACCESS_REQUIRED" : "LLM_USAGE_UNAVAILABLE", message: status === 401 || status === 403 ? "Cloudflare Access authentication is required." : "LLM usage data is temporarily unavailable." }, status);
  }
}
