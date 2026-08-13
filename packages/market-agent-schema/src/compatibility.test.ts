import assert from "node:assert/strict";
import test from "node:test";
import { compatibleAgentResult, type AgentResult } from "./index.ts";

function legacy(limitations: string[]): AgentResult {
  return { status: "partial", headline: "legacy", summary: "legacy", observations: [], portfolioImpacts: [], watchNext: [], limitations, evidenceFingerprint: "sha256:legacy", mode: "market-only" };
}

test("legacy gateway fallback remains distinguishable", () => {
  const result = compatibleAgentResult(legacy(["Gateway 暂不可用（模型候选均失败），已降级为确定性结果。"]));
  assert.equal(result.outcome?.narration.source, "deterministic_fallback");
  assert.equal(result.outcome?.evidence.coverage, "sufficient");
});

test("legacy model-like results do not claim confirmed provenance", () => {
  const result = compatibleAgentResult(legacy(["公告能力降级。"]));
  assert.equal(result.outcome?.narration.source, "unknown");
  assert.equal(result.outcome?.evidence.coverage, "limited");
});
