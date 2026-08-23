import type { MarketAgentCommand } from "@zxlab/market-agent-schema";

export const MARKET_AGENT_CLOSE_REVIEW_GATEWAY_TASK = "market-agent-close-review" as const;
export const MARKET_AGENT_ANSWER_GATEWAY_TASK = "market-agent-answer" as const;
export const FINANCIAL_TOOL_PLANNER_GATEWAY_TASK = "market-agent-financial-tool-plan" as const;
/** Backwards-compatible name for the established review task. */
export const MARKET_AGENT_GATEWAY_TASK = MARKET_AGENT_CLOSE_REVIEW_GATEWAY_TASK;
export const MARKET_AGENT_ALLOWED_CALLER = "market-agent-worker" as const;
export type MarketAgentGatewayTask = typeof MARKET_AGENT_CLOSE_REVIEW_GATEWAY_TASK | typeof MARKET_AGENT_ANSWER_GATEWAY_TASK | typeof FINANCIAL_TOOL_PLANNER_GATEWAY_TASK;

export function gatewayTaskForWorkflow(workflow: MarketAgentCommand["workflow"]): MarketAgentGatewayTask {
  return workflow === "ask" ? MARKET_AGENT_ANSWER_GATEWAY_TASK : MARKET_AGENT_CLOSE_REVIEW_GATEWAY_TASK;
}

export function isAllowedGatewayCall(input: { caller: string; task: string }): boolean {
  return input.caller === MARKET_AGENT_ALLOWED_CALLER && (
    input.task === MARKET_AGENT_CLOSE_REVIEW_GATEWAY_TASK
    || input.task === MARKET_AGENT_ANSWER_GATEWAY_TASK
    || input.task === FINANCIAL_TOOL_PLANNER_GATEWAY_TASK
  );
}
