import type { HealthState, PublicModule, RuntimePublicSnapshot } from "@zxlab/runtime-schema";
import { RuntimeRepository } from "./repository";

const rank: Record<HealthState, number> = { operational: 0, unknown: 1, degraded: 2, offline: 3 };
const worst = (states: HealthState[]): HealthState => states.reduce((result, state) => rank[state] > rank[result] ? state : result, "operational");

function publicDevices(...sources: unknown[]) {
  const devices = sources.flatMap((source) => Array.isArray(source) ? source : []).filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
  const seen = new Set<string>();
  return devices.flatMap((device) => {
    const key = String(device.id ?? device.name ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const state = String(device.state ?? device.presence ?? "unknown");
    return [{
      ...(typeof device.id === "string" ? { id: device.id } : {}),
      name: String(device.name),
      type: typeof device.type === "string" ? device.type : typeof device.platform === "string" ? device.platform : "managed device",
      state: ["online", "offline", "idle"].includes(state) ? state : "unknown",
      ...(typeof device.lastSeen === "string" ? { lastSeen: device.lastSeen } : {}),
      ...(typeof device.publicTask === "string" ? { publicTask: device.publicTask } : {}),
    }];
  });
}

export async function publicSnapshot(repository: RuntimeRepository): Promise<RuntimePublicSnapshot> {
  const rows = await repository.latestRows();
  const now = new Date();
  const stale = rows.length === 0 || rows.some((row) => now.getTime() - Date.parse(row.observed_at) > 180_000);
  const byId = new Map(rows.map((row) => [row.service_id, row]));
  const runtimeRows = ["pages", "signal", "zxtoolkit", "market"].map((id) => byId.get(id)).filter(Boolean) as typeof rows;
  const runtimeState = runtimeRows.length ? worst(runtimeRows.map((row) => row.status)) : "unknown";
  const signal = byId.get("signal");
  const pages = byId.get("pages");
  const toolkit = byId.get("zxtoolkit");
  const usage = byId.get("codex-usage");
  const memory = signal?.public?.memory as Record<string, unknown> | undefined;
  const devices = publicDevices(pages?.public?.devices, toolkit?.public?.agents);
  const devicesAvailable = pages?.public?.devicesAvailable === true || Array.isArray(toolkit?.public?.agents);
  const usageData = usage?.public?.usage as Record<string, unknown> | undefined;
  const modules: PublicModule[] = [
    { id: "runtime", name: "Runtime", status: runtimeState, summary: `${runtimeRows.filter((row) => row.status === "operational").length} / ${runtimeRows.length || 4} core services operational.`, updatedAt: runtimeRows[0]?.observed_at ?? null, data: { operational: runtimeRows.filter((row) => row.status === "operational").length, total: runtimeRows.length || 4 } },
    { id: "memory", name: "Memory", status: signal?.status ?? "unknown", summary: memory ? "Canonical Memory is connected and auditable." : "Memory telemetry is unavailable.", updatedAt: signal?.observed_at ?? null, data: memory ?? null },
    { id: "agents", name: "Device", status: devicesAvailable ? worst([pages?.status ?? "unknown", toolkit?.status ?? "unknown"]) : "unknown", summary: devicesAvailable ? `${devices.length} privacy-filtered devices reported.` : "Device presence is unavailable.", updatedAt: pages?.observed_at ?? toolkit?.observed_at ?? null, data: devicesAvailable ? { agents: devices } : null },
    { id: "usage", name: "Usage", status: usage?.status ?? "unknown", summary: usageData ? "Live Codex usage is connected." : "Codex usage is unavailable.", updatedAt: usage?.observed_at ?? null, data: usageData ?? null },
  ];
  const overallStatus = stale ? "unknown" : worst(modules.map((module) => module.status));
  const counts = { total: modules.length, operational: 0, degraded: 0, offline: 0, unknown: 0 };
  modules.forEach((module) => { counts[module.status] += 1; });
  return { schemaVersion: "1", overall: { status: overallStatus, summary: stale ? "The latest runtime snapshot is stale." : overallStatus === "operational" ? "All public systems are operational." : "One or more public systems need attention.", stale, counts }, modules, activities: await repository.activities(), generatedAt: now.toISOString() };
}
