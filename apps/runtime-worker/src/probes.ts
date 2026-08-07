import type { HealthState, ServiceHealthReport } from "@zxlab/runtime-schema";

export interface ProbeResult {
  report: ServiceHealthReport;
  latencyMs: number;
  errorCode: string | null;
}

interface ProbeDefinition {
  id: string;
  load(env: Env, signal: AbortSignal): Promise<Response>;
}

const internalHeaders = (env: Env) => ({
  Accept: "application/json",
  Authorization: `Bearer ${env.ZX_RUNTIME_SERVICE_TOKEN}`,
});

const probes: ProbeDefinition[] = [
  { id: "pages", load: (env, signal) => fetch(env.PAGES_HEALTH_URL, { headers: internalHeaders(env), signal }) },
  { id: "signal", load: (env, signal) => env.SIGNAL.fetch("https://signal.internal/internal/runtime/health", { headers: internalHeaders(env), signal }) },
  { id: "zxtoolkit", load: (env, signal) => env.ZXTOOLKIT.fetch("https://zxtoolkit.internal/internal/runtime/health", { headers: internalHeaders(env), signal }) },
  { id: "market", load: (env, signal) => env.MARKET.fetch("https://market.internal/internal/runtime/health", { headers: internalHeaders(env), signal }) },
  { id: "market-agent", load: (env, signal) => env.MARKET_AGENT.fetch("https://market-agent.internal/internal/runtime/health", { headers: internalHeaders(env), signal }) },
  { id: "codex-usage", load: (env, signal) => fetch(env.PAGES_USAGE_URL, { headers: internalHeaders(env), signal }) },
];

function unavailable(serviceId: string, state: HealthState, errorCode: string): ServiceHealthReport {
  return { schemaVersion: "1", serviceId, status: state, version: "unknown", generatedAt: new Date().toISOString(), checks: [{ id: "endpoint", status: state, errorCode }] };
}

function validReport(value: unknown): value is ServiceHealthReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === "1" && typeof input.serviceId === "string" && typeof input.status === "string" && Array.isArray(input.checks);
}

function codexReport(value: unknown): ServiceHealthReport {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const upstreamStatus = typeof input.status === "string" ? input.status : "error";
  const status: HealthState = upstreamStatus === "online" ? "operational" : upstreamStatus === "stale" ? "degraded" : "offline";
  return {
    schemaVersion: "1",
    serviceId: "codex-usage",
    status,
    version: "collector",
    generatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
    checks: [{ id: "collector", status }],
    public: { usage: input },
  };
}

async function runProbe(definition: ProbeDefinition, env: Env): Promise<ProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await definition.load(env, controller.signal);
    if (!response.ok) return { report: unavailable(definition.id, response.status >= 500 ? "offline" : "degraded", `HTTP_${response.status}`), latencyMs: Date.now() - startedAt, errorCode: `HTTP_${response.status}` };
    const value = await response.json() as unknown;
    const report = definition.id === "codex-usage" ? codexReport(value) : validReport(value) ? value : unavailable(definition.id, "degraded", "INVALID_REPORT");
    return { report, latencyMs: Date.now() - startedAt, errorCode: report.status === "operational" ? null : report.checks.find((check) => check.errorCode)?.errorCode ?? "UPSTREAM_DEGRADED" };
  } catch (error) {
    const code = error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
    return { report: unavailable(definition.id, "offline", code), latencyMs: Date.now() - startedAt, errorCode: code };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAllProbes(env: Env) {
  return Promise.all(probes.map((probe) => runProbe(probe, env)));
}
