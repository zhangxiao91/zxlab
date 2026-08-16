import { createResearchReportV2, type ResearchReportV2 } from "@zxlab/market-agent-schema";
import type { AgentRunView } from "./client";

const importance = { high: 0, medium: 1, low: 2 } as const;

export function buildMarketReviewReport(result: NonNullable<AgentRunView["result"]>): ResearchReportV2 {
  const report = result.report ?? createResearchReportV2(result);
  return {
    ...report,
    conclusion: {
      headline: report.conclusion.headline.trim() || "市场研究报告",
      summary: report.conclusion.summary.trim() || "本次运行没有形成可展示的结论。",
      evidenceIds: [...report.conclusion.evidenceIds],
    },
    basis: [...report.basis].sort(compareObservations),
    analysis: [...report.analysis].sort(compareObservations),
    risks: [...report.risks],
    watchNext: [...report.watchNext],
    sources: [...report.sources],
  };
}

function compareObservations(left: ResearchReportV2["basis"][number], right: ResearchReportV2["basis"][number]) {
  return importance[left.importance] - importance[right.importance]
    || left.title.localeCompare(right.title, "zh-CN");
}
