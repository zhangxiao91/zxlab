import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketReviewReport } from "../src/features/market-agent/market-review-report.ts";

test("review report preserves every report chapter and orders findings by decision relevance", () => {
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

  assert.equal(report.title, "收盘复盘");
  assert.equal(report.executiveSummary, "市场已收盘，价格仅为最后观测。");
  assert.deepEqual(report.findings.map((item) => item.id), ["fact", "unknown", "low"]);
  assert.equal(report.portfolioImpacts[0]?.id, "impact");
  assert.equal(report.watchNext[0]?.condition, "下一交易时段");
  assert.deepEqual(report.limitations, ["公告能力降级"]);
});
