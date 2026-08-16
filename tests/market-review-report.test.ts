import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMarketReviewReport } from "../src/features/market-agent/market-review-report.ts";
import { ResearchReport, RunNavigator } from "../src/features/market-agent/AgentToday.tsx";

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
