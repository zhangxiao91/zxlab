export const MARKET_AGENT_GATEWAY_TASK = "market-agent-close-review" as const;
export const MARKET_AGENT_ALLOWED_CALLER = "market-agent-worker" as const;

export function isAllowedGatewayCall(input: { caller: string; task: string }): boolean {
  return input.caller === MARKET_AGENT_ALLOWED_CALLER && input.task === MARKET_AGENT_GATEWAY_TASK;
}
