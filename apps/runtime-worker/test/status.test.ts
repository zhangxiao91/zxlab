import { describe, expect, it } from "vitest";
import { publicSnapshot } from "../src/status";
import type { RuntimeRepository } from "../src/repository";

function repository(rows: Awaited<ReturnType<RuntimeRepository["latestRows"]>>): RuntimeRepository {
  return {
    latestRows: async () => rows,
    activities: async () => [],
  } as unknown as RuntimeRepository;
}

const row = (serviceId: string, publicData: Record<string, unknown> | null = null) => ({
  service_id: serviceId,
  status: "operational" as const,
  version: "abc1234",
  observed_at: new Date().toISOString(),
  latency_ms: 12,
  error_code: null,
  checks_json: "[]",
  public_json: publicData ? JSON.stringify(publicData) : null,
  public: publicData,
});

describe("public runtime snapshot", () => {
  it("never invents healthy data when there are no samples", async () => {
    const snapshot = await publicSnapshot(repository([]));
    expect(snapshot.overall.status).toBe("unknown");
    expect(snapshot.overall.stale).toBe(true);
    expect(snapshot.modules.every((module) => module.data === null || module.id === "runtime")).toBe(true);
  });

  it("projects real service payloads into four privacy-filtered modules", async () => {
    const snapshot = await publicSnapshot(repository([
      row("pages", { devicesAvailable: true, devices: [{ id: "server-a", name: "Server A", type: "server", state: "online" }] }), row("market"),
      row("signal", { memory: { activeCount: 4, proposedCount: 1 } }),
      row("zxtoolkit", { agents: [{ name: "Studio", presence: "online", batteryLevel: "medium" }] }),
      row("codex-usage", { usage: { status: "online", limits: [] } }),
    ]));
    expect(snapshot.overall.status).toBe("operational");
    expect(snapshot.modules.map((module) => module.id)).toEqual(["runtime", "memory", "agents", "usage"]);
    expect(snapshot.modules.find((module) => module.id === "memory")?.data).toMatchObject({ activeCount: 4 });
    expect(snapshot.modules.find((module) => module.id === "agents")?.name).toBe("Device");
    expect(snapshot.modules.find((module) => module.id === "agents")?.data).toMatchObject({ agents: [{ name: "Server A" }, { name: "Studio" }] });
    expect((snapshot.modules.find((module) => module.id === "agents")?.data as { agents: Array<Record<string, unknown>> }).agents[1]).toEqual({ name: "Studio", type: "managed device", state: "online" });
  });

  it("deduplicates devices without exposing a substitute when both sources are absent", async () => {
    const duplicate = { id: "server-a", name: "Server A", type: "server", state: "online" };
    const snapshot = await publicSnapshot(repository([
      row("pages", { devicesAvailable: true, devices: [duplicate] }), row("market"), row("signal"),
      row("zxtoolkit", { agents: [duplicate] }), row("codex-usage"),
    ]));
    expect((snapshot.modules.find((module) => module.id === "agents")?.data as { agents: unknown[] }).agents).toHaveLength(1);
  });
});
