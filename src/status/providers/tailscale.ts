import { requestStatusJson } from "./http";
import type {
  DeviceStatus,
  ModuleResult,
  StatusProvider,
  StatusProviderOptions,
  StatusSnapshot,
} from "../types";

function unavailable<T>(source: string, message: string): ModuleResult<T> {
  return { state: "unavailable", data: null, source, message };
}

export const tailscaleStatusProvider: StatusProvider = {
  id: "tailscale",
  async getSnapshot(options: StatusProviderOptions = {}) {
    const updatedAt = new Date().toISOString();
    const activity = unavailable<StatusSnapshot["activity"]["data"]>(
      "No activity provider",
      "Live public activity is not connected yet.",
    ) as StatusSnapshot["activity"];

    const [usageRequest, deviceRequest] = await Promise.allSettled([
      requestStatusJson<NonNullable<StatusSnapshot["usage"]["data"]>>("/api/status/usage", options.signal),
      requestStatusJson<DeviceStatus[]>("/api/status/devices", options.signal),
    ]);
    const usage: StatusSnapshot["usage"] = usageRequest.status === "fulfilled"
      ? {
          state: "ready",
          data: usageRequest.value,
          source: "Codex public gateway",
          updatedAt: usageRequest.value.updatedAt,
          ...(usageRequest.value.status === "stale" ? { message: "Showing the most recent cached Codex snapshot." } : {}),
        }
      : unavailable("Codex public gateway", "Live Codex usage is temporarily unavailable.");
    const deviceResult: ModuleResult<DeviceStatus[]> = deviceRequest.status === "fulfilled"
      ? deviceRequest.value.length > 0
        ? { state: "ready", data: deviceRequest.value, source: "Tailscale public gateway", updatedAt }
        : {
            state: "empty",
            data: null,
            source: "Tailscale public gateway",
            updatedAt,
            message: "No allowlisted public devices were returned.",
          }
      : {
          state: "error",
          data: null,
          source: "Tailscale public gateway",
          message: "Live device status is temporarily unavailable.",
        };
    const readyCount = [usage.state, deviceResult.state].filter((state) => state === "ready" || state === "empty").length;
    const stale = usage.data?.status === "stale";

    return {
      overall: {
        state: readyCount === 2 && !stale ? "operational" : readyCount > 0 ? "partial" : "unknown",
        label: readyCount === 2 && !stale ? "Live systems operational" : readyCount > 0 ? "Partial live data" : "Live status unavailable",
        message: readyCount === 2
          ? stale ? "Device presence is live; Codex usage is served from a recent cache." : "Privacy-filtered devices and Codex usage are connected."
          : "Each public source is isolated, so one failure does not hide the other modules.",
        sourceState: readyCount === 2 ? "connected" : readyCount > 0 ? "partial" : "unavailable",
        stale,
      },
      usage,
      devices: deviceResult,
      activity,
      updatedAt: usage.updatedAt ?? updatedAt,
      source: "ZXLab public status gateways",
      isMock: false,
    } satisfies StatusSnapshot;
  },
};
