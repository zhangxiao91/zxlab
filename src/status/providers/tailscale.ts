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
    const usage = unavailable<StatusSnapshot["usage"]["data"]>(
      "No usage provider",
      "Live usage data is not connected yet.",
    ) as StatusSnapshot["usage"];
    const activity = unavailable<StatusSnapshot["activity"]["data"]>(
      "No activity provider",
      "Live public activity is not connected yet.",
    ) as StatusSnapshot["activity"];

    try {
      const devices = await requestStatusJson<DeviceStatus[]>("/api/status/devices", options.signal);
      const deviceResult: ModuleResult<DeviceStatus[]> = devices.length > 0
        ? { state: "ready", data: devices, source: "Tailscale public gateway", updatedAt }
        : {
            state: "empty",
            data: null,
            source: "Tailscale public gateway",
            updatedAt,
            message: "No allowlisted public devices were returned.",
          };

      return {
        overall: {
          state: "partial",
          label: "Live devices connected",
          message: "Privacy-filtered Tailscale presence is live. Usage and activity remain disconnected.",
          sourceState: "partial",
          stale: false,
        },
        usage,
        devices: deviceResult,
        activity,
        updatedAt,
        source: "Tailscale public gateway",
        isMock: false,
      } satisfies StatusSnapshot;
    } catch {
      return {
        overall: {
          state: "unknown",
          label: "Live devices unavailable",
          message: "The Tailscale gateway could not provide a safe public snapshot.",
          sourceState: "unavailable",
          stale: false,
        },
        usage,
        devices: {
          state: "error",
          data: null,
          source: "Tailscale public gateway",
          message: "Live device status is temporarily unavailable.",
        },
        activity,
        updatedAt,
        source: "Tailscale public gateway",
        isMock: false,
      } satisfies StatusSnapshot;
    }
  },
};
