import assert from "node:assert/strict";
import test from "node:test";
import { compatibleAgentResult, createResearchReportV2, isCancellableRunStatus, isRetryableRunStatus, isRunTraceEvent, isTerminalRunStatus, type AgentResult, type SealedEvidenceBundle } from "./index.ts";

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

test("legacy narration receives an explicit Research Report v2 projection", () => {
  const result = compatibleAgentResult({
    ...legacy(["估值能力暂不可用。"]),
    observations: [
      { id: "fact", class: "fact", importance: "high", title: "确定事实", explanation: "事实正文", evidenceIds: ["evidence-1"] },
      { id: "inference", class: "inference", importance: "medium", title: "可能含义", explanation: "可能仍需确认", evidenceIds: ["evidence-1"] },
      { id: "unknown", class: "unknown", importance: "low", title: "未知项", explanation: "仍未知", evidenceIds: ["evidence-2"] },
    ],
  });

  assert.equal(result.report?.version, "research-report.v2");
  assert.deepEqual(result.report?.basis.map((item) => item.id), ["fact"]);
  assert.deepEqual(result.report?.analysis.map((item) => item.id), ["inference"]);
  assert.deepEqual(result.report?.risks.map((item) => item.kind), ["uncertainty", "data_boundary"]);
  assert.deepEqual(result.report?.conclusion.evidenceIds, []);
  assert.deepEqual(result.report?.sources.map((item) => item.evidenceId), ["evidence-1", "evidence-2"]);
});

test("an invalid persisted report is rebuilt instead of reaching the UI", () => {
  const result = compatibleAgentResult({
    ...legacy([]),
    report: { version: "research-report.v2", conclusion: null } as unknown as AgentResult["report"],
  });

  assert.equal(result.report?.version, "research-report.v2");
  assert.deepEqual(result.report?.conclusion, {
    headline: "legacy",
    summary: "legacy",
    evidenceIds: [],
  });
  assert.deepEqual(result.report?.basis, []);
});

test("Research Report sources are assembled from sealed deterministic provenance", () => {
  const evidence: SealedEvidenceBundle = {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "p1",
    workflow: "close_review",
    watchlistRevision: "w1",
    instrumentIds: ["SSE:600000"],
    items: [{
      id: "research-1",
      kind: "market_fact",
      origin: "server-observed",
      reliable: true,
      value: {
        type: "research_fact",
        researchFingerprint: "sha256:research",
        planVersion: "price-context.v1",
        fact: {
          id: "fact-1",
          kind: "market_baseline",
          subjectId: "SSE:600000",
          baselineType: "price_return",
          window: 20,
          observationPeriod: { start: "2026-07-18T07:00:00.000Z", end: "2026-08-15T07:00:00.000Z", tradingSessions: 20 },
          value: { decimal: "0.1234", unit: "ratio" },
          formula: { id: "market.price_return.v1", version: "1", expression: "close[t] / close[t-window] - 1", inputArtifactIds: ["bars:fixture"], parameters: { window: "20", annualizationSessions: "250", adjustment: "qfq" }, rounding: "decimal-12-nearest" },
          provenance: { providers: ["fixture"], sourceArtifactIds: ["bars:fixture"], sourceAsOf: "2026-08-15T07:00:00.000Z", retrievedAt: "2026-08-15T07:01:00.000Z" },
          quality: { status: "operational", reliable: true, coverage: { actual: 21, required: 21 }, warnings: [] },
        },
      },
    }],
    contextUses: [],
    fingerprint: "sha256:test",
    sealedAt: "2026-08-15T07:02:00.000Z",
  };
  const narration = {
    ...legacy([]),
    conclusionEvidenceIds: ["research-1"],
    observations: [{ id: "fact", class: "fact" as const, importance: "high" as const, title: "确定事实", explanation: "事实正文", evidenceIds: ["research-1"] }],
  };

  const report = createResearchReportV2(narration, evidence);

  assert.deepEqual(report.sources[0], {
    evidenceId: "research-1",
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    providers: ["fixture"],
    asOf: "2026-08-15T07:00:00.000Z",
    retrievedAt: "2026-08-15T07:01:00.000Z",
  });
  assert.deepEqual(report.conclusion.evidenceIds, ["research-1"]);
  assert.deepEqual(report.factBlocks?.[0], {
    id: "fact-block:research-1",
    evidenceId: "research-1",
    factId: "fact-1",
    kind: "market_baseline",
    subjectId: "SSE:600000",
    title: "SSE:600000 · 20 日价格收益",
    context: [{ label: "观察区间", value: "2026-07-18T07:00:00.000Z — 2026-08-15T07:00:00.000Z" }],
    metrics: [{
      key: "value",
      label: "价格收益",
      decimal: "0.1234",
      unit: "ratio",
      formula: { id: "market.price_return.v1", version: "1", expression: "close[t] / close[t-window] - 1", inputArtifactIds: ["bars:fixture"], parameters: { window: "20", annualizationSessions: "250", adjustment: "qfq" }, rounding: "decimal-12-nearest" },
    }],
    quality: { status: "operational", reliable: true, coverage: { actual: 21, required: 21 }, warnings: [] },
    provenance: { researchFingerprint: "sha256:research", planVersion: "price-context.v1", providers: ["fixture"], sourceArtifactIds: ["bars:fixture"], sourceAsOf: "2026-08-15T07:00:00.000Z", retrievedAt: "2026-08-15T07:01:00.000Z" },
  });

  report.factBlocks![0].provenance.sourceArtifactIds = ["bars:other"];
  assert.equal(compatibleAgentResult({ ...narration, mode: "market-only", report }).report?.factBlocks, undefined);
});

test("Research Fact blocks are current-only projections and remain backward compatible", () => {
  const current = createResearchReportV2(legacy([]), {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "p1",
    workflow: "close_review",
    watchlistRevision: "w1",
    instrumentIds: [],
    items: [],
    contextUses: [],
    fingerprint: "sha256:current",
    sealedAt: "2026-08-15T07:02:00.000Z",
  });
  const legacyReport = createResearchReportV2(legacy([]));

  assert.deepEqual(current.factBlocks, []);
  assert.equal(Object.hasOwn(legacyReport, "factBlocks"), false);
  assert.equal(compatibleAgentResult({ ...legacy([]), report: legacyReport }).report?.factBlocks, undefined);
});

test("Research Report sources retain quote source and corroborating providers", () => {
  const evidence: SealedEvidenceBundle = {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "p1",
    workflow: "ask",
    watchlistRevision: "w1",
    instrumentIds: ["SSE:600000"],
    items: [{
      id: "quote-1",
      kind: "market_fact",
      origin: "server-observed",
      reliable: true,
      value: {
        type: "quote",
        source: "primary-feed",
        provider: "normalized-provider",
        asOf: "2026-08-15T07:00:00.000Z",
        receivedAt: "2026-08-15T07:00:02.000Z",
        corroboration: { observations: [{ provider: "secondary-feed" }, { provider: "primary-feed" }] },
      },
    }],
    contextUses: [],
    fingerprint: "sha256:quote",
    sealedAt: "2026-08-15T07:00:03.000Z",
  };
  const narration = {
    ...legacy([]),
    conclusionEvidenceIds: ["quote-1"],
    observations: [{ id: "fact", class: "fact" as const, importance: "high" as const, title: "行情事实", explanation: "事实正文", evidenceIds: ["quote-1"] }],
  };

  const report = createResearchReportV2(narration, evidence);

  assert.deepEqual(report.sources[0]?.providers, ["normalized-provider", "primary-feed", "secondary-feed"]);
  assert.equal(report.sources[0]?.asOf, "2026-08-15T07:00:00.000Z");
  assert.equal(report.sources[0]?.retrievedAt, "2026-08-15T07:00:02.000Z");
});

test("Run lifecycle classification includes durable cancellation", () => {
  assert.equal(isTerminalRunStatus("cancelled"), true);
  assert.equal(isTerminalRunStatus("retry_wait"), false);
  assert.equal(isCancellableRunStatus("queued"), true);
  assert.equal(isCancellableRunStatus("validating"), true);
  assert.equal(isCancellableRunStatus("cancelled"), false);
  assert.equal(isRetryableRunStatus("failed"), true);
  assert.equal(isRetryableRunStatus("cancelled"), true);
  assert.equal(isRetryableRunStatus("success"), false);
});

test("Run trace validation rejects unbounded extra fields", () => {
  const event = {
    id: "trace-1",
    runId: "run-1",
    sequence: 1,
    type: "run_created",
    stage: "queued",
    attempt: 0,
    recoveryGeneration: 0,
    occurredAt: "2026-08-16T00:00:00.000Z",
    provenance: { source: "market-agent-worker", operation: "run.create" },
  };
  assert.equal(isRunTraceEvent(event), true);
  assert.equal(isRunTraceEvent({ ...event, thought: "private" }), false);
  assert.equal(isRunTraceEvent({ ...event, provenance: { ...event.provenance, rawText: "private" } }), false);
});
