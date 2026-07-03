export type StatusProviderMode = "mock" | "remote";

const requestedMode = import.meta.env.PUBLIC_STATUS_PROVIDER;
const apiBaseUrl = import.meta.env.PUBLIC_STATUS_API_BASE_URL?.replace(/\/$/, "") ?? null;

export const statusConfig = Object.freeze({
  providerMode: (requestedMode === "remote" && apiBaseUrl ? "remote" : "mock") as StatusProviderMode,
  apiBaseUrl,
  requestTimeoutMs: 8000,
  staleAfterMs: 15 * 60 * 1000,
  autoRefreshMs: null as number | null,
  scenarioQueryKey: "status-state",
  endpoints: {
    overall: "/api/status",
    usage: "/api/status/usage",
    devices: "/api/status/devices",
    activity: "/api/status/activity",
  },
});
