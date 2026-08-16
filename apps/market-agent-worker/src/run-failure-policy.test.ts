import assert from "node:assert/strict";
import test from "node:test";
import { settleRunFailure } from "./run-failure-policy.ts";
import { ResearchFactError } from "./research-fact-reader.ts";

test("consumer fails non-retryable Research Fact errors and defers retryable failures", async () => {
  const calls: Array<{ method: "fail" | "defer"; code: string }> = [];
  const runs = {
    async fail(_runId: string, _leaseToken: string, code: string) { calls.push({ method: "fail", code }); return true; },
    async defer(_runId: string, _leaseToken: string, code: string) { calls.push({ method: "defer", code }); return true; },
  };

  assert.equal(await settleRunFailure(runs, "run-1", "lease-1", new ResearchFactError("RESEARCH_FACT_UNAUTHORIZED", false), "ASK_RETRYABLE"), "ack");
  assert.equal(await settleRunFailure(runs, "run-2", "lease-2", new ResearchFactError("RESEARCH_FACT_TIMEOUT", true), "ASK_RETRYABLE"), "retry");
  assert.equal(await settleRunFailure(runs, "run-3", "lease-3", new Error("MARKET_TRANSIENT"), "CLOSE_REVIEW_RETRYABLE"), "retry");
  assert.deepEqual(calls, [
    { method: "fail", code: "RESEARCH_FACT_UNAUTHORIZED" },
    { method: "defer", code: "RESEARCH_FACT_TIMEOUT" },
    { method: "defer", code: "CLOSE_REVIEW_RETRYABLE" },
  ]);
});

test("a cancelled Run does not retry after its old lease loses the defer CAS", async () => {
  const runs = {
    async fail() { return false; },
    async defer() { return false; },
  };

  assert.equal(
    await settleRunFailure(runs, "run-cancelled", "old-lease", new Error("UPSTREAM_FAILED"), "ASK_RETRYABLE"),
    "ack",
  );
});
