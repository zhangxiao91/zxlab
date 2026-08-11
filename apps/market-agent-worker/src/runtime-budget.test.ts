import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_AGENT_GATEWAY_CALLS_PER_RUN,
  MARKET_AGENT_GATEWAY_REQUEST_TIMEOUT_MS,
  MARKET_AGENT_NON_GATEWAY_BUDGET_MS,
  MARKET_AGENT_RUN_LEASE_MS,
  MARKET_AGENT_RUN_STREAM_TIMEOUT_MS,
} from "./runtime-budget.ts";

test("Run lease covers collection and both Gateway narration attempts", () => {
  assert.ok(
    MARKET_AGENT_RUN_LEASE_MS
      >= MARKET_AGENT_GATEWAY_REQUEST_TIMEOUT_MS * MARKET_AGENT_GATEWAY_CALLS_PER_RUN
        + MARKET_AGENT_NON_GATEWAY_BUDGET_MS,
  );
  assert.equal(MARKET_AGENT_RUN_LEASE_MS, 240_000);
});

test("Run stream remains open beyond the full Run lease", () => {
  assert.ok(MARKET_AGENT_RUN_STREAM_TIMEOUT_MS > MARKET_AGENT_RUN_LEASE_MS);
  assert.equal(MARKET_AGENT_RUN_STREAM_TIMEOUT_MS, 300_000);
});
