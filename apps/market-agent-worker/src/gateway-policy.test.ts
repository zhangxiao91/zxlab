import assert from "node:assert/strict";
import test from "node:test";
import {
  FINANCIAL_TOOL_PLANNER_GATEWAY_TASK,
  THESIS_IMPACT_GATEWAY_TASK,
  isAllowedGatewayCall,
} from "./gateway-policy.ts";

test("financial tool planner uses its dedicated bounded Gateway task", () => {
  assert.equal(FINANCIAL_TOOL_PLANNER_GATEWAY_TASK, "market-agent-financial-tool-plan");
  assert.equal(isAllowedGatewayCall({ caller: "market-agent-worker", task: FINANCIAL_TOOL_PLANNER_GATEWAY_TASK }), true);
});

test("thesis impact classification uses a dedicated bounded Gateway task", () => {
  assert.equal(THESIS_IMPACT_GATEWAY_TASK, "market-agent-thesis-impact");
  assert.equal(isAllowedGatewayCall({ caller: "market-agent-worker", task: THESIS_IMPACT_GATEWAY_TASK }), true);
  assert.equal(isAllowedGatewayCall({ caller: "browser", task: THESIS_IMPACT_GATEWAY_TASK }), false);
});

test("financial tool planner remains restricted to the Market Agent caller", () => {
  assert.equal(isAllowedGatewayCall({ caller: "browser", task: FINANCIAL_TOOL_PLANNER_GATEWAY_TASK }), false);
  assert.equal(isAllowedGatewayCall({ caller: "signal-worker", task: FINANCIAL_TOOL_PLANNER_GATEWAY_TASK }), false);
});
