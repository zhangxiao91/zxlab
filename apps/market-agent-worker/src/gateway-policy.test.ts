import assert from "node:assert/strict";
import test from "node:test";
import {
  FINANCIAL_TOOL_PLANNER_GATEWAY_TASK,
  isAllowedGatewayCall,
} from "./gateway-policy.ts";

test("financial tool planner uses its dedicated bounded Gateway task", () => {
  assert.equal(FINANCIAL_TOOL_PLANNER_GATEWAY_TASK, "market-agent-financial-tool-plan");
  assert.equal(isAllowedGatewayCall({ caller: "market-agent-worker", task: FINANCIAL_TOOL_PLANNER_GATEWAY_TASK }), true);
});

test("financial tool planner remains restricted to the Market Agent caller", () => {
  assert.equal(isAllowedGatewayCall({ caller: "browser", task: FINANCIAL_TOOL_PLANNER_GATEWAY_TASK }), false);
  assert.equal(isAllowedGatewayCall({ caller: "signal-worker", task: FINANCIAL_TOOL_PLANNER_GATEWAY_TASK }), false);
});
