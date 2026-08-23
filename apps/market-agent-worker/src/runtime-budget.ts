export const MARKET_AGENT_GATEWAY_REQUEST_TIMEOUT_MS = 90_000;
export const MARKET_AGENT_GATEWAY_CALLS_PER_RUN = 2;
export const MARKET_AGENT_NON_GATEWAY_BUDGET_MS = 30_000;
export const MARKET_AGENT_TOOL_PLANNER_BUDGET_MS = 12_000;
export const MARKET_AGENT_FINANCIAL_TOOL_BUDGET_MS = 35_000;
export const MARKET_AGENT_LEASE_SAFETY_MARGIN_MS = 30_000;

export const MARKET_AGENT_RUN_LEASE_MS = 300_000;
export const MARKET_AGENT_LEGACY_RUN_LEASE_MS = 240_000;

export const MARKET_AGENT_RUN_STREAM_GRACE_MS = 60_000;
export const MARKET_AGENT_RUN_STREAM_TIMEOUT_MS =
  MARKET_AGENT_RUN_LEASE_MS + MARKET_AGENT_RUN_STREAM_GRACE_MS;

export function marketAgentRunLeaseMs(mode: "disabled" | "shadow" | "enabled"): number {
  return mode === "disabled" ? MARKET_AGENT_LEGACY_RUN_LEASE_MS : MARKET_AGENT_RUN_LEASE_MS;
}

export function marketAgentRunStreamTimeoutMs(mode: "disabled" | "shadow" | "enabled"): number {
  return marketAgentRunLeaseMs(mode) + MARKET_AGENT_RUN_STREAM_GRACE_MS;
}
