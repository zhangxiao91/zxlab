import type { AgentObservationView, AgentRunView } from "./client";

export interface MarketReviewReport {
  title: string;
  executiveSummary: string;
  findings: AgentObservationView[];
  portfolioImpacts: AgentObservationView[];
  watchNext: Array<{ condition: string; reason: string; evidenceIds: string[] }>;
  limitations: string[];
}

const importance = { high: 0, medium: 1, low: 2 } as const;
const observationClass = { fact: 0, inference: 1, unknown: 2 } as const;

export function buildMarketReviewReport(result: NonNullable<AgentRunView["result"]>): MarketReviewReport {
  return {
    title: result.headline.trim() || "盘后市场复盘",
    executiveSummary: result.summary.trim() || "本次复盘没有形成可展示的执行摘要。",
    findings: [...result.observations].sort(compareObservations),
    portfolioImpacts: [...result.portfolioImpacts].sort(compareObservations),
    watchNext: result.watchNext.filter((item) => item.condition.trim() && item.reason.trim()),
    limitations: result.limitations.filter((item) => item.trim()),
  };
}

function compareObservations(left: AgentObservationView, right: AgentObservationView) {
  return importance[left.importance] - importance[right.importance]
    || observationClass[left.class] - observationClass[right.class]
    || left.title.localeCompare(right.title, "zh-CN");
}
