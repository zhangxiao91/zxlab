import assert from "node:assert/strict";
import test from "node:test";
import type { AskScope, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { buildNarrationContext } from "./narration-context.ts";
import { resolveNarrativeDepthPolicy, validateNarrativeDepth } from "./narrative-depth.ts";

function bundle(items: SealedEvidenceBundle["items"], scope: AskScope = "today_change"): SealedEvidenceBundle {
  return {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "profile-depth",
    workflow: "ask",
    watchlistRevision: "watchlist-depth",
    instrumentIds: ["SSE:600000"],
    items,
    contextUses: [],
    fingerprint: "sha256:depth",
    sealedAt: "2026-08-21T08:00:00.000Z",
    ask: { scope, planVersion: "ask-plan.v1" },
  };
}

test("today-change depth policy requires a report when market and research evidence are available", () => {
  const evidence = bundle([
    { id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 10, previousClose: 9.8 } },
    { id: "baseline", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "research_fact", fact: { kind: "market_baseline", subjectId: "SSE:600000", baselineType: "price_return", window: 20, value: { decimal: "0.1", unit: "ratio" } } } },
  ]);
  const context = buildNarrationContext({ evidence, workflow: "ask", askScope: "today_change" });

  const policy = resolveNarrativeDepthPolicy({ workflow: "ask", askScope: "today_change", context });

  assert.equal(policy.version, "narrative-depth.v1");
  assert.equal(policy.summary.minCharacters, 100);
  assert.deepEqual(policy.requiredEvidenceIds, ["baseline", "quote"]);
  assert.deepEqual(policy.minimums, { conclusionEvidenceIds: 2, basis: 2, analysis: 1, portfolioImpacts: 0, watchNext: 1 });
  assert.equal(policy.allowLimitationClaims, false);
});

test("depth validation rejects a tiny fact brief with empty report sections", () => {
  const evidence = bundle([
    { id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 10, previousClose: 9.8 } },
    { id: "baseline", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "research_fact", fact: { kind: "market_baseline", subjectId: "SSE:600000", baselineType: "price_return", window: 20, value: { decimal: "0.1", unit: "ratio" } } } },
  ]);
  const context = buildNarrationContext({ evidence, workflow: "ask", askScope: "today_change" });
  const policy = resolveNarrativeDepthPolicy({ workflow: "ask", askScope: "today_change", context });

  const issues = validateNarrativeDepth({
    status: "success",
    headline: "甲",
    summary: "甲。乙。",
    conclusionEvidenceIds: [],
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: evidence.fingerprint,
  }, policy);

  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_SUMMARY_TOO_SHORT")));
  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_BASIS_TOO_SHALLOW")));
  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_ANALYSIS_TOO_SHALLOW")));
  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_WATCH_NEXT_MISSING")));
  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_REQUIRED_EVIDENCE_UNCOVERED")));
});

test("sparse evidence lowers structural minima instead of forcing invented analysis", () => {
  const evidence = bundle([
    { id: "quality", kind: "market_fact", origin: "server-observed", reliable: false, value: { type: "snapshot_context", quality: { reliable: false, freshness: "unknown" } } },
    { id: "limit", kind: "limitation", origin: "server-observed", reliable: true, value: { capability: "quotes", status: "unavailable", warnings: ["quotes unavailable"] } },
  ], "data_quality");
  const context = buildNarrationContext({ evidence, workflow: "ask", askScope: "data_quality" });

  const policy = resolveNarrativeDepthPolicy({ workflow: "ask", askScope: "data_quality", context });

  assert.equal(policy.summary.minCharacters, 48);
  assert.deepEqual(policy.minimums, { conclusionEvidenceIds: 1, basis: 0, analysis: 0, portfolioImpacts: 0, watchNext: 1 });
  assert.equal(policy.allowLimitationClaims, true);
});

test("a sufficient Evidence Bundle rejects invented stale and provider-delay limitations", () => {
  const evidence = bundle([
    { id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 10, previousClose: 9.8 } },
  ]);
  const context = buildNarrationContext({ evidence, workflow: "ask", askScope: "today_change" });
  const policy = resolveNarrativeDepthPolicy({ workflow: "ask", askScope: "today_change", context });

  const issues = validateNarrativeDepth({
    status: "partial",
    headline: "行情观察",
    summary: "证据支持对最近有效市场观察作出定性说明，并且主要依据已经封存。这里解释这些事实为何值得关注，同时把能够确认的观察与后续仍需验证的含义分开。由于数据由服务端确定性链路提供，具体数值和时间口径应以所引证据为准。",
    conclusionEvidenceIds: ["quote"],
    observations: [{ id: "basis", class: "fact", importance: "high", title: "市场事实已封存", explanation: "可靠行情已经形成可复核的市场事实，具体定量结果由 Evidence 单独呈现。", evidenceIds: ["quote"] }],
    portfolioImpacts: [],
    watchNext: [{ condition: "关注后续可靠市场事实是否改变当前观察", reason: "新的封存证据可以检验当前定性判断是否延续。", evidenceIds: ["quote"] }],
    limitations: ["周末数据已经过期，且供应商传输延迟，因此结果不可靠。"],
    evidenceFingerprint: evidence.fingerprint,
  }, policy);

  assert.ok(issues.some((issue) => issue.startsWith("NARRATION_LIMITATION_UNSUPPORTED")));
});

test("required topics need distinct observations that explain why each fact matters", () => {
  const evidence = bundle([
    { id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 10 } },
    { id: "baseline", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "research_fact", fact: { kind: "market_baseline", subjectId: "SSE:600000" } } },
  ]);
  const policy = resolveNarrativeDepthPolicy({ workflow: "ask", askScope: "today_change", context: buildNarrationContext({ evidence, workflow: "ask", askScope: "today_change" }) });
  const filler = "可靠行情与研究证据均已封存。这里继续复述市场材料，文字长度已经达到要求，内容依次排列并保持完整。";

  const issues = validateNarrativeDepth({
    summary: `${filler}${filler}`,
    conclusionEvidenceIds: ["quote", "baseline"],
    observations: [
      { class: "fact", explanation: filler, evidenceIds: ["quote", "baseline"] },
      { class: "fact", explanation: filler, evidenceIds: ["quote"] },
      { class: "inference", explanation: filler, evidenceIds: ["quote"] },
    ],
    portfolioImpacts: [],
    watchNext: [{ evidenceIds: ["quote"] }],
    limitations: [],
  }, policy);

  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_REQUIRED_TOPIC_UNCOVERED")));
  assert.ok(issues.some((issue) => issue.startsWith("NARRATIVE_DEPTH_EXPLANATION_MISSING_SIGNIFICANCE")));
});

test("authoritative sufficient assessment keeps advisory limitation evidence out of narration claims", () => {
  const evidence = bundle([
    { id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 10 } },
    { id: "advisory", kind: "limitation", origin: "server-observed", reliable: true, value: { capability: "optional-context", status: "degraded" } },
  ]);
  const policy = resolveNarrativeDepthPolicy({
    workflow: "ask",
    askScope: "today_change",
    context: buildNarrationContext({ evidence, workflow: "ask", askScope: "today_change" }),
    evidenceAssessment: { coverage: "sufficient", delivery: "primary", fallbackCapabilities: [], limitations: [{ code: "OPTIONAL_CONTEXT", severity: "advisory", message: "optional" }] },
  });

  assert.equal(policy.allowLimitationClaims, false);
});
