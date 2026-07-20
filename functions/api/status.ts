import { getStatusResponse } from "../../src/status/domain/service.ts";
import { filterStatusByVisibility } from "../../src/status/domain/visibility.ts";
import { memoryProvider, runtimeProvider } from "../../src/status/domain/mock.ts";
import type { AgentStatus, StatusActivity, StatusModule, StatusProvider, StatusVisibility } from "../../src/status/domain/types.ts";
import { getPublicTailscaleDevices, type TailscaleEnv } from "../_lib/tailscale.ts";
import { fetchCodexUsage, type CodexUsageEnv } from "../_lib/codex-usage.ts";

interface StatusEnv extends TailscaleEnv, CodexUsageEnv { }
interface FunctionContext { request: Request; env: StatusEnv; }
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function liveAgentProvider(env: StatusEnv): StatusProvider | null {
  if (!env.TAILSCALE_PUBLIC_DEVICES) return null;
  return {
    async getStatus(): Promise<StatusModule> {
      const devices = await getPublicTailscaleDevices(env);
      const agents: AgentStatus[] = devices.map((device) => ({
        id: device.id,
        name: device.name,
        status: device.state === "online" ? "operational" : device.state === "offline" ? "offline" : "unknown",
        online: device.state === "online",
        platform: "managed device",
        version: "not shared",
        lastHeartbeatAt: device.lastSeen ?? device.updatedAt,
        capabilities: [],
      }));
      const online = agents.filter((agent) => agent.online).length;
      const status = agents.length === 0 ? "unknown" : online === agents.length ? "operational" : online > 0 ? "degraded" : "offline";
      return { id: "remote-agents", name: "Remote Agents", description: "Live allowlisted device presence", category: "agent", status, summary: `${online} / ${agents.length} agents online from the live Tailscale source.`, updatedAt: new Date().toISOString(), visibility: "authenticated", critical: false, metrics: [{ id: "online", label: "Online", value: `${online} / ${agents.length}`, visibility: "authenticated" }], details: { kind: "agent", agents } };
    },
    async getActivities(): Promise<StatusActivity[]> { return []; },
  };
}

export const onRequestGet = async (context: FunctionContext) => {
  try {
    /* Future Cloudflare Access identity is resolved here. */
    const accessLevel: StatusVisibility = "authenticated";
    const agent = liveAgentProvider(context.env);
    const response = await getStatusResponse(agent ? [agent, memoryProvider, runtimeProvider] : undefined);
    if (context.env.CODEX_USAGE_API_URL && context.env.CODEX_USAGE_API_TOKEN) {
      try {
        const usage = await fetchCodexUsage(context.env);
        const runtime = response.modules.find((module) => module.id === "runtime");
        if (runtime) runtime.metrics.push({ id: "codex-tokens", label: "Codex tokens today", value: usage.tokenSummary.todayTokens, format: "number", visibility: "authenticated" });
      } catch { /* Existing usage endpoint remains independently available. */ }
    }
    return new Response(JSON.stringify(filterStatusByVisibility(response, accessLevel)), { headers });
  } catch {
    return new Response(JSON.stringify({ error: { code: "STATUS_UNAVAILABLE", message: "Status data is temporarily unavailable." }, generatedAt: new Date().toISOString() }), { status: 503, headers });
  }
};
