import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMarketReviewReport } from "../src/features/market-agent/market-review-report.ts";
import { MarketReferenceSummary, ResearchReport, RunNavigator } from "../src/features/market-agent/AgentToday.tsx";

test("Research Report v2 preserves conclusion, basis, analysis, risks, watch items, and sources", () => {
  const report = buildMarketReviewReport({
    status: "partial",
    headline: "  收盘复盘  ",
    summary: "  市场已收盘，价格仅为最后观测。  ",
    observations: [
      { id: "low", class: "fact", importance: "low", title: "低优先", explanation: "低", evidenceIds: ["e-low"] },
      { id: "unknown", class: "unknown", importance: "high", title: "高优先未知", explanation: "未知", evidenceIds: ["e-unknown"] },
      { id: "fact", class: "fact", importance: "high", title: "高优先事实", explanation: "事实", evidenceIds: ["e-fact"] },
    ],
    portfolioImpacts: [{ id: "impact", class: "unknown", importance: "high", title: "持仓影响", explanation: "尚无法确认", evidenceIds: ["e-impact"] }],
    watchNext: [{ condition: "下一交易时段", reason: "确认价格变化", evidenceIds: ["e-watch"] }],
    limitations: ["公告能力降级"],
  });

  assert.equal(report.version, "research-report.v2");
  assert.equal(report.conclusion.headline, "收盘复盘");
  assert.equal(report.conclusion.summary, "市场已收盘，价格仅为最后观测。");
  assert.deepEqual(report.basis.map((item) => item.id), ["fact", "low"]);
  assert.deepEqual(report.analysis.map((item) => item.id), []);
  assert.deepEqual(report.risks.map((item) => item.kind), ["uncertainty", "uncertainty", "data_boundary"]);
  assert.equal(report.watchNext[0]?.condition, "下一交易时段");
  assert.deepEqual(report.sources.map((source) => source.evidenceId), ["e-low", "e-fact", "e-unknown", "e-impact", "e-watch"]);
});

test("Research Report and Run history expose one selected Run with inspectable citations", () => {
  const result = {
    status: "success" as const,
    headline: "报告结论",
    summary: "这是结论、依据、推演与风险都可追溯的报道式摘要。",
    observations: [{ id: "fact", class: "fact" as const, importance: "high" as const, title: "确定依据", explanation: "依据正文", evidenceIds: ["e-1"] }],
    portfolioImpacts: [{ id: "analysis", class: "inference" as const, importance: "medium" as const, title: "可能影响", explanation: "可能仍需确认", evidenceIds: ["e-1"] }],
    watchNext: [{ condition: "条件", reason: "理由", evidenceIds: ["e-1"] }],
    limitations: ["估值数据缺失"],
  };
  const reportSource = renderToStaticMarkup(createElement(ResearchReport, { report: buildMarketReviewReport(result), onEvidence: () => undefined }));
  const run = { id: "run-1", workflow: "ask", status: "success", createdAt: "2026-08-15T10:00:00.000Z", updatedAt: "2026-08-15T10:01:00.000Z", evidenceFingerprint: "sha256:e" };
  const navigatorSource = renderToStaticMarkup(createElement(RunNavigator, {
    runs: [run], selectedRunId: run.id, onSelect: () => undefined, onExport: async () => undefined,
    onLoadMore: async () => undefined, exportBusy: false, exportNote: null, hasMore: false, loadingMore: false,
  }));

  for (const chapter of ["结论", "依据", "推演", "风险与数据边界", "后续观察", "来源引用"]) assert.match(reportSource, new RegExp(chapter));
  assert.match(reportSource, /来源 1/);
  assert.match(navigatorSource, /aria-current="true"/);
});

test("Research Report renders sealed deterministic values, formula, provider, as-of, and provenance", () => {
  const report = buildMarketReviewReport({
    status: "success",
    headline: "确定性市场基线",
    summary: "数值由 Research Fact Plane 单独渲染。",
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    report: {
      version: "research-report.v2",
      conclusion: { headline: "确定性市场基线", summary: "数值由 Research Fact Plane 单独渲染。", evidenceIds: [] },
      factBlocks: [{
        id: "fact-block:e-1",
        evidenceId: "e-1",
        factId: "price-return-20",
        kind: "market_baseline",
        subjectId: "SSE:600000",
        title: "SSE:600000 · 20 日价格收益",
        context: [{ label: "观察区间", value: "2026-07-18T07:00:00.000Z — 2026-08-15T07:00:00.000Z" }],
        metrics: [{ key: "value", label: "价格收益", decimal: "0.1234", unit: "ratio", formula: { id: "market.price_return.v1", version: "1", expression: "close[t] / close[t-window] - 1", inputArtifactIds: ["bars:fixture"], parameters: { window: "20" }, rounding: "decimal-12-nearest" } }],
        quality: { status: "operational", reliable: true, coverage: { actual: 21, required: 21 }, warnings: [] },
        provenance: { researchFingerprint: "sha256:research", planVersion: "price-context.v1", providers: ["fixture-provider"], sourceArtifactIds: ["bars:fixture"], sourceAsOf: "2026-08-15T07:00:00.000Z", retrievedAt: "2026-08-15T07:01:00.000Z" },
      }],
      basis: [],
      analysis: [],
      risks: [],
      watchNext: [],
      sources: [{ evidenceId: "e-1", providers: ["fixture-provider"], asOf: "2026-08-15T07:00:00.000Z", reliable: true }],
    },
  });

  const source = renderToStaticMarkup(createElement(ResearchReport, { report, onEvidence: () => undefined }));
  for (const expected of ["确定性 Fact Blocks", "0.1234", "比率", "market.price_return.v1@1", "close[t] / close[t-window] - 1", "fixture-provider", "bars:fixture", "price-context.v1", "来源 1"]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Research Report renders financial period, derived value, and distinct YoY and QoQ metrics", () => {
  const report = buildMarketReviewReport({
    status: "success",
    headline: "财务更新",
    summary: "公告事实与财务变化均来自封存证据。",
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    report: {
      version: "research-report.v2",
      conclusion: { headline: "财务更新", summary: "公告事实与财务变化均来自封存证据。", evidenceIds: [] },
      factBlocks: [{
        id: "fact-block:financial-1",
        evidenceId: "financial-1",
        factId: "financial:SSE:600000:operating_revenue:2026Q2",
        kind: "financial_metric",
        subjectId: "SSE:600000",
        title: "SSE:600000 · 营业收入",
        context: [
          { label: "报告期", value: "2026-04-01T00:00:00.000Z — 2026-06-30T00:00:00.000Z" },
          { label: "报告口径", value: "单季度" },
          { label: "同比可比期", value: "2025-04-01T00:00:00.000Z — 2025-06-30T00:00:00.000Z" },
          { label: "环比可比期", value: "2026-01-01T00:00:00.000Z — 2026-03-31T00:00:00.000Z" },
        ],
        metrics: [
          { key: "value", label: "营业收入", decimal: "2500000000", unit: "CNY", formula: { id: "financial.single_quarter.v1", version: "1", expression: "current_cumulative - previous_cumulative", inputArtifactIds: ["filing:h1", "filing:q1"], parameters: { period: "Q2" }, rounding: "exact-decimal" } },
          { key: "comparison_yoy", label: "同比", decimal: "0.12", unit: "ratio", formula: { id: "financial.yoy.v1", version: "1", expression: "current / prior - 1", inputArtifactIds: ["filing:h1", "filing:q1"], parameters: {}, rounding: "decimal-12-nearest" } },
          { key: "comparison_qoq", label: "环比", decimal: "0.03", unit: "ratio", formula: { id: "financial.qoq.v1", version: "1", expression: "current / prior - 1", inputArtifactIds: ["filing:h1", "filing:q1"], parameters: {}, rounding: "decimal-12-nearest" } },
        ],
        quality: { status: "operational", reliable: true, coverage: { actual: 4, required: 4 }, warnings: [] },
        provenance: { researchFingerprint: "sha256:financial", planVersion: "company-update.v1", providers: ["eastmoney", "cninfo"], sourceArtifactIds: ["filing:h1", "filing:q1"], sourceAsOf: "2026-07-31T10:00:00.000Z", retrievedAt: "2026-08-15T07:01:00.000Z" },
      }],
      basis: [],
      analysis: [],
      risks: [],
      watchNext: [],
      sources: [{ evidenceId: "financial-1", providers: ["eastmoney", "cninfo"], asOf: "2026-07-31T10:00:00.000Z", reliable: true }],
    },
  });

  const source = renderToStaticMarkup(createElement(ResearchReport, { report, onEvidence: () => undefined }));
  for (const expected of ["财务指标", "营业收入", "同比", "环比", "报告期", "报告口径", "同比可比期", "环比可比期", "financial.single_quarter.v1@1", "current_cumulative - previous_cumulative", "eastmoney", "cninfo"]) assert.match(source, new RegExp(expected));
});

test("Market reference separates weekend equivalence, freshness, coverage, and delivery", () => {
  const evidence = {
    schemaVersion: "market-agent.v1" as const,
    eventRuleVersion: "market-event.v1" as const,
    profileId: "p1",
    workflow: "ask" as const,
    watchlistRevision: "w1",
    instrumentIds: ["SSE:600000"],
    items: [{ id: "context", kind: "market_fact" as const, origin: "server-observed" as const, reliable: true, value: { type: "snapshot_context", quality: { freshness: "fresh" }, reference: { requestedCalendarDate: "2026-08-16", effectiveTradingDate: "2026-08-14", session: "holiday", semantics: "last_effective_session" } } }],
    contextUses: [],
    fingerprint: "sha256:e" as const,
    sealedAt: "2026-08-16T02:00:00.000Z",
  };
  const source = renderToStaticMarkup(createElement(MarketReferenceSummary, { evidence, outcome: { execution: "completed", narration: { source: "model" }, evidence: { coverage: "sufficient", delivery: "primary", fallbackCapabilities: [], limitations: [] }, mode: "market-only" } }));

  for (const expected of ["数据日期", "周末等效", "2026/08/14", "fresh", "sufficient", "primary", "休市不等于数据降级"]) assert.match(source, new RegExp(expected));
});

test("legacy reports identify the missing reference without rewriting history and expose retry", () => {
  const evidence = {
    schemaVersion: "market-agent.v1" as const,
    eventRuleVersion: "market-event.v1" as const,
    profileId: "p1",
    workflow: "ask" as const,
    watchlistRevision: "w1",
    instrumentIds: [],
    items: [{ id: "context", kind: "market_fact" as const, origin: "server-observed" as const, reliable: true, value: { type: "snapshot_context", quality: { freshness: "fresh" } } }],
    contextUses: [],
    fingerprint: "sha256:legacy" as const,
    sealedAt: "2026-08-16T02:00:00.000Z",
  };
  const source = renderToStaticMarkup(createElement(MarketReferenceSummary, { evidence, onRetry: async () => undefined }));

  assert.match(source, /旧版口径/);
  assert.match(source, /历史结果不会被改写/);
  assert.match(source, /按当前口径重试/);
});
