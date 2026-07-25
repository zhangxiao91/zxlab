import { fetchCodexUsage, type CodexUsageEnv } from "../_lib/codex-usage.ts";
import { getPublicTailscaleDevices, type TailscaleEnv } from "../_lib/tailscale.ts";
import { getStatusResponse } from "../../src/status/domain/service.ts";
import { filterStatusByVisibility } from "../../src/status/domain/visibility.ts";
import type {
  AgentStatus,
  StatusActivity,
  StatusModule,
  StatusProvider,
} from "../../src/status/domain/types.ts";

interface PagesEnv {
  CF_PAGES_BRANCH?: string;
  CF_PAGES_COMMIT_SHA?: string;
  CF_PAGES_URL?: string;
}

interface StatusEnv extends TailscaleEnv, CodexUsageEnv, PagesEnv {}
interface FunctionContext { request: Request; env: StatusEnv; }

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function unavailableAgentProvider(): StatusProvider {
  return {
    async getStatus(): Promise<StatusModule> {
      const updatedAt = new Date().toISOString();
      return {
        id: "remote-agents",
        name: "Remote Agents",
        description: "Allowlisted device presence",
        category: "agent",
        status: "unknown",
        summary: "No live remote-agent status source is configured.",
        updatedAt,
        visibility: "public",
        critical: false,
        metrics: [],
        details: { kind: "agent", agents: [] },
      };
    },
  };
}

function liveAgentProvider(env: StatusEnv): StatusProvider {
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
      return {
        id: "remote-agents",
        name: "Remote Agents",
        description: "Live allowlisted device presence",
        category: "agent",
        status,
        summary: `${online} / ${agents.length} agents online from the live Tailscale source.`,
        updatedAt: new Date().toISOString(),
        visibility: "public",
        critical: false,
        metrics: [{ id: "online", label: "Online", value: `${online} / ${agents.length}`, visibility: "authenticated" }],
        details: { kind: "agent", agents },
      };
    },
  };
}

function unavailableMemoryProvider(): StatusProvider {
  return {
    async getStatus(): Promise<StatusModule> {
      const updatedAt = new Date().toISOString();
      return {
        id: "memory",
        name: "Memory",
        description: "Ingestion, indexing, and recall",
        category: "memory",
        status: "unknown",
        summary: "No live memory status source is configured.",
        updatedAt,
        visibility: "public",
        critical: false,
        metrics: [],
        details: {
          kind: "memory",
          memory: {
            freshness: "unknown",
            sources: [],
            lastError: "Live memory telemetry is not connected.",
          },
        },
      };
    },
  };
}

function runtimeProvider(env: StatusEnv): StatusProvider {
  return {
    async getStatus(): Promise<StatusModule> {
      const updatedAt = new Date().toISOString();
      const version = env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ?? "local";
      return {
        id: "runtime",
        name: "zxlab Runtime",
        description: "Public site and status gateway",
        category: "runtime",
        status: "operational",
        summary: "The public site and unified Status API are responding.",
        updatedAt,
        visibility: "public",
        critical: true,
        metrics: [
          { id: "version", label: "Version", value: version, format: "text" },
          { id: "branch", label: "Environment", value: env.CF_PAGES_BRANCH ?? "local", format: "text" },
        ],
        details: {
          kind: "runtime",
          runtime: {
            version,
            services: [
              { id: "web", name: "Web frontend", status: "operational", summary: "Serving the current status page." },
              { id: "status-api", name: "Status API", status: "operational", summary: "Responding to this request." },
            ],
          },
        },
      };
    },
    async getActivities(): Promise<StatusActivity[]> {
      const createdAt = new Date().toISOString();
      return [{
        id: `status-api-${createdAt}`,
        moduleId: "runtime",
        type: "heartbeat",
        title: "Unified Status API responded successfully",
        status: "operational",
        createdAt,
        visibility: "public",
      }];
    },
  };
}

export const onRequestGet = async (context: FunctionContext) => {
  try {
    const agent = context.env.TAILSCALE_PUBLIC_DEVICES
      ? liveAgentProvider(context.env)
      : unavailableAgentProvider();
    const response = await getStatusResponse([
      agent,
      unavailableMemoryProvider(),
      runtimeProvider(context.env),
    ]);

    if (context.env.CODEX_USAGE_API_URL && context.env.CODEX_USAGE_API_TOKEN) {
      try {
        const usage = await fetchCodexUsage(context.env);
        const runtime = response.modules.find((module) => module.id === "runtime");
        if (runtime) {
          runtime.metrics.push({
            id: "codex-tokens",
            label: "Codex tokens today",
            value: usage.tokenSummary.todayTokens,
            format: "number",
            visibility: "authenticated",
          });
        }
      } catch {
        // The dedicated usage module reports its own upstream state.
      }
    }

    return new Response(JSON.stringify(filterStatusByVisibility(response, "public")), { headers });
  } catch {
    return new Response(JSON.stringify({
      error: {
        code: "STATUS_UNAVAILABLE",
        message: "Status data is temporarily unavailable.",
      },
      generatedAt: new Date().toISOString(),
    }), { status: 503, headers });
  }
};
