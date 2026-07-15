export type StatusProviderMode = "mock" | "tailscale" | "remote" | "zxtoolkit";

const requestedMode = import.meta.env.PUBLIC_STATUS_PROVIDER;
const apiBaseUrl = import.meta.env.PUBLIC_STATUS_API_BASE_URL?.replace(/\/$/, "") ?? "";
const providerMode: StatusProviderMode = requestedMode === "zxtoolkit" ? "zxtoolkit" : requestedMode === "tailscale"
  ? "tailscale"
  : requestedMode === "remote"
    ? "remote"
    : import.meta.env.PROD
      ? "tailscale"
      : "mock";

export const statusConfig = Object.freeze({
  providerMode,
  apiBaseUrl,
  requestTimeoutMs: 8000,
  staleAfterMs: 15 * 60 * 1000,
  autoRefreshMs: providerMode === "mock"
    ? null
    : Math.max(60_000, Number(import.meta.env.PUBLIC_STATUS_REFRESH_MS || 120_000)),
  scenarioQueryKey: "status-state",
  endpoints: {
    overall: "/api/status",
    usage: "/api/status/usage",
    devices: "/api/status/devices",
    activity: "/api/status/activity",
  },
});
