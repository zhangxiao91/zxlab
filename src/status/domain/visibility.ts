import type { StatusResponse, StatusVisibility } from "./types.ts";

const rank: Record<StatusVisibility, number> = { public: 0, authenticated: 1, admin: 2 };
const allowed = (visibility: StatusVisibility | undefined, level: StatusVisibility) => rank[visibility ?? "public"] <= rank[level];

export function filterStatusByVisibility(response: StatusResponse, accessLevel: StatusVisibility): StatusResponse {
  const modules = response.modules.filter((module) => allowed(module.visibility, accessLevel)).map((module) => {
    const metrics = module.metrics.filter((metric) => allowed(metric.visibility, accessLevel));
    if (accessLevel !== "public") return { ...module, metrics };
    if (module.details.kind === "agent") {
      return {
        ...module,
        metrics,
        details: {
          kind: "agent" as const,
          agents: module.details.agents.map((agent) => ({
            ...agent,
            name: "Remote agent",
            capabilities: [],
            currentTask: undefined,
            lastError: undefined,
          })),
        },
      };
    }
    if (module.details.kind === "memory") {
      return {
        ...module,
        metrics,
        details: {
          kind: "memory" as const,
          memory: {
            ...module.details.memory,
            sources: module.details.memory.sources.map((source) => ({ ...source, name: "Connected source" })),
            lastError: undefined,
          },
        },
      };
    }
    return { ...module, metrics, details: { kind: "runtime" as const, runtime: { ...module.details.runtime, services: [] } } };
  });
  return { ...response, modules, activities: response.activities.filter((activity) => allowed(activity.visibility, accessLevel)) };
}
