import { statusConfig } from "../config";
import type { ModuleResult, OverallStatus, StatusProvider, StatusProviderOptions, StatusSnapshot } from "../types";

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!statusConfig.apiBaseUrl) throw new Error("Status API base URL is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), statusConfig.requestTimeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(`${statusConfig.apiBaseUrl}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Status request failed: ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function settledModule<T>(result: PromiseSettledResult<T>, source: string): ModuleResult<T> {
  return result.status === "fulfilled"
    ? { state: "ready", data: result.value, source, updatedAt: new Date().toISOString() }
    : { state: "error", data: null, source, message: "This status module could not be loaded." };
}

export const remoteStatusProvider: StatusProvider = {
  id: "remote",
  async getSnapshot(options: StatusProviderOptions = {}) {
    const [overall, usage, devices, activity] = await Promise.allSettled([
      request<OverallStatus>(statusConfig.endpoints.overall, options.signal),
      request<StatusSnapshot["usage"]["data"]>(statusConfig.endpoints.usage, options.signal),
      request<StatusSnapshot["devices"]["data"]>(statusConfig.endpoints.devices, options.signal),
      request<StatusSnapshot["activity"]["data"]>(statusConfig.endpoints.activity, options.signal),
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
