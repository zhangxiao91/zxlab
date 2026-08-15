import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceLimitation, RunOutcome } from "@zxlab/market-agent-schema";
import { degradedTool } from "../src/features/market-agent/AskPanel.tsx";

function outcome(limitations: EvidenceLimitation[]): RunOutcome {
  return {
    execution: "completed",
    narration: { source: "model", model: "test-model", fallbackIndex: 0 },
    evidence: { coverage: limitations.length ? "limited" : "sufficient", delivery: "primary", fallbackCapabilities: [], limitations },
    mode: "market-only",
  };
}

test("run activity attributes Market Snapshot degradation only to market limitations", () => {
  const quoteLimitation: EvidenceLimitation = { code: "CAPABILITY_NOT_FRESH", capability: "quotes", severity: "material", message: "quote stale" };

  assert.equal(degradedTool("Market Snapshot", [], outcome([quoteLimitation])), true);
  assert.equal(degradedTool("Evidence Assembler", [], outcome([quoteLimitation])), false);
});

test("run activity attributes Research Fact limitations to evidence assembly", () => {
  const researchLimitation: EvidenceLimitation = { code: "BENCHMARK_MAPPING_MISSING", capability: "research:market_baselines", severity: "material", message: "mapping missing" };

  assert.equal(degradedTool("Market Snapshot", [], outcome([researchLimitation])), false);
  assert.equal(degradedTool("Evidence Assembler", [], outcome([researchLimitation])), true);
});
