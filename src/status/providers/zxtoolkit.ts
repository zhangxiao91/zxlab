import { requestStatusJson } from "./http";
import type { DeviceStatus, ModuleResult, StatusProvider, StatusProviderOptions, StatusSnapshot } from "../types";

interface PublicStatusResponse {
  updatedAt: string | null;
  stale: boolean;
  devices: Array<{ name: string; presence: "online" | "recently_online" | "offline"; batteryLevel?: "high" | "medium" | "low"; charging?: boolean }>;
  activity?: { stepsBucket?: string };
}

const unavailable = <T>(message: string): ModuleResult<T> => ({ state: "unavailable", data: null, source: "zxtoolkit", message });

export const zxtoolkitStatusProvider: StatusProvider = {
  id: "zxtoolkit",
  async getSnapshot(options: StatusProviderOptions = {}) {
    const response = await requestStatusJson<PublicStatusResponse>("/api/public/status", options.signal);
    const updatedAt = response.updatedAt ?? new Date().toISOString();
    const devices: DeviceStatus[] = response.devices.map((device, index) => ({
      id: `public-device-${index + 1}`,
      name: device.name,
      type: "phone",
      state: device.presence === "online" ? "online" : device.presence === "recently_online" ? "idle" : "offline",
      lastSeen: updatedAt,
      publicTask: `Battery ${device.batteryLevel ?? "not shared"}${device.charging ? " · charging" : ""}`,
      updatedAt
    }));
    const hasDevices = devices.length > 0;
    return {
      overall: { state: hasDevices && !response.stale ? "operational" : hasDevices ? "partial" : "unknown", label: hasDevices ? "Personal devices connected" : "No public device snapshot", message: "Privacy-filtered device state published by zxtoolkit.", sourceState: hasDevices ? "connected" : "unavailable", stale: response.stale },
      usage: unavailable("Codex usage remains an independent source."),
      devices: hasDevices ? { state: "ready", data: devices, source: "zxtoolkit Pulse", updatedAt } : { state: "empty", data: null, source: "zxtoolkit Pulse", updatedAt, message: "No unexpired public Pulse snapshot." },
      activity: unavailable(response.activity?.stepsBucket ? `Public steps bucket: ${response.activity.stepsBucket}` : "No public activity field."),
      updatedAt,
      source: "zxtoolkit public status API",
      isMock: false
    } satisfies StatusSnapshot;
  }
};
