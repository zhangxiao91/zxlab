import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvidenceLimitation, RunOutcome } from "@zxlab/market-agent-schema";
import { degradedTool, RunActivity } from "../src/features/market-agent/AskPanel.tsx";

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

test("failed run activity reports an unknown failure stage without blaming a specific stage", () => {
  const source = renderToStaticMarkup(createElement(RunActivity, {
    status: "failed",
    runId: "run-failed",
  }));

  assert.match(source, /现有记录没有提供具体失败阶段/);
  assert.doesNotMatch(source, /data-state="failed"/);
  assert.equal((source.match(/data-state="unknown"/g) ?? []).length, 5);
});
