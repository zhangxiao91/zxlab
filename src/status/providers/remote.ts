import { requestStatusJson } from "./http";
import type { ModuleResult, OverallStatus, StatusProvider, StatusProviderOptions, StatusSnapshot } from "../types";
import { statusConfig } from "../config";

function settledModule<T>(result: PromiseSettledResult<T>, source: string): ModuleResult<T> {
  return result.status === "fulfilled"
    ? { state: "ready", data: result.value, source, updatedAt: new Date().toISOString() }
    : { state: "error", data: null, source, message: "This status module could not be loaded." };
}

export const remoteStatusProvider: StatusProvider = {
  id: "remote",
  async getSnapshot(options: StatusProviderOptions = {}) {
    const [overall, usage, devices, activity] = await Promise.allSettled([
      requestStatusJson<OverallStatus>(statusConfig.endpoints.overall, options.signal),
      requestStatusJson<StatusSnapshot["usage"]["data"]>(statusConfig.endpoints.usage, options.signal),
      requestStatusJson<StatusSnapshot["devices"]["data"]>(statusConfig.endpoints.devices, options.signal),
      requestStatusJson<StatusSnapshot["activity"]["data"]>(statusConfig.endpoints.activity, options.signal),
    ]);
    const updatedAt = new Date().toISOString();

    return {
      overall: overall.status === "fulfilled" ? overall.value : {
        state: "unknown",
        label: "Status partially unavailable",
        message: "The overall source could not be loaded.",
        sourceState: "partial",
        stale: false,
      },
      usage: settledModule(usage, "Remote usage provider") as StatusSnapshot["usage"],
      devices: settledModule(devices, "Remote device provider") as StatusSnapshot["devices"],
      activity: settledModule(activity, "Remote activity provider") as StatusSnapshot["activity"],
      updatedAt,
      source: "Remote public status API",
      isMock: false,
    };
  },
};
