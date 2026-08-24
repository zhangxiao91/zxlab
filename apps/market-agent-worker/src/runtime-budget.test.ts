import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_AGENT_GATEWAY_CALLS_PER_RUN,
  MARKET_AGENT_GATEWAY_REQUEST_TIMEOUT_MS,
  MARKET_AGENT_NON_GATEWAY_BUDGET_MS,
  MARKET_AGENT_FINANCIAL_TOOL_BUDGET_MS,
  MARKET_AGENT_TOOL_PLANNER_BUDGET_MS,
  MARKET_AGENT_THESIS_IMPACT_BUDGET_MS,
  MARKET_AGENT_RUN_LEASE_MS,
  MARKET_AGENT_RUN_STREAM_TIMEOUT_MS,
  marketAgentRunLeaseMs,
  marketAgentRunStreamTimeoutMs,
} from "./runtime-budget.ts";

test("Run lease covers planning, financial collection, thesis projection, and both Gateway narration attempts", () => {
  assert.ok(
    MARKET_AGENT_RUN_LEASE_MS
      >= MARKET_AGENT_GATEWAY_REQUEST_TIMEOUT_MS * MARKET_AGENT_GATEWAY_CALLS_PER_RUN
        + MARKET_AGENT_NON_GATEWAY_BUDGET_MS
        + MARKET_AGENT_TOOL_PLANNER_BUDGET_MS
        + MARKET_AGENT_FINANCIAL_TOOL_BUDGET_MS
        + MARKET_AGENT_THESIS_IMPACT_BUDGET_MS,
  );
  assert.equal(MARKET_AGENT_TOOL_PLANNER_BUDGET_MS, 12_000);
  assert.equal(MARKET_AGENT_FINANCIAL_TOOL_BUDGET_MS, 35_000);
  assert.equal(MARKET_AGENT_THESIS_IMPACT_BUDGET_MS, 12_000);
  assert.equal(MARKET_AGENT_RUN_LEASE_MS, 300_000);
});

test("Run stream remains open beyond the full Run lease", () => {
  assert.ok(MARKET_AGENT_RUN_STREAM_TIMEOUT_MS > MARKET_AGENT_RUN_LEASE_MS);
  assert.equal(MARKET_AGENT_RUN_STREAM_TIMEOUT_MS, 360_000);
});

test("disabled mode preserves the legacy lease and stream budgets", () => {
  assert.equal(marketAgentRunLeaseMs("disabled"), 240_000);
  assert.equal(marketAgentRunStreamTimeoutMs("disabled"), 300_000);
  assert.equal(marketAgentRunLeaseMs("shadow"), 300_000);
  assert.equal(marketAgentRunLeaseMs("enabled"), 300_000);
  assert.equal(marketAgentRunStreamTimeoutMs("enabled"), 360_000);
  assert.equal(marketAgentRunLeaseMs("disabled", "fact_only"), 300_000);
  assert.equal(marketAgentRunLeaseMs("disabled", "enabled"), 300_000);
  assert.equal(marketAgentRunStreamTimeoutMs("disabled", "enabled"), 360_000);
});
