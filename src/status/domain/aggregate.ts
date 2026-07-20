import type { HealthStatus, StatusModule, StatusOverview } from "./types.ts";

export function aggregateStatus(modules: StatusModule[], updatedAt: string): StatusOverview {
  const counts = { total: modules.length, operational: 0, degraded: 0, offline: 0, unknown: 0 };
  for (const module of modules) counts[module.status] += 1;
  const critical = modules.filter((module) => module.critical !== false);
  const status: HealthStatus = critical.some((module) => module.status === "offline") ? "offline"
    : critical.some((module) => module.status === "degraded") ? "degraded"
    : critical.length > 0 && critical.every((module) => module.status === "operational") ? "operational" : "unknown";
  const summary = status === "operational" ? "All core modules are operating normally."
    : status === "degraded" ? "Some capabilities are delayed, but zxlab remains available."
    : status === "offline" ? "A critical module is currently unavailable."
    : "System health is temporarily unavailable.";
  return { status, summary, updatedAt, counts };
}
