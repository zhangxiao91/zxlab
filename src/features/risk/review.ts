import type { EvidencePack, ReviewResult } from "./types";

export interface ReviewService { review(pack: EvidencePack): Promise<ReviewResult> }

export class MockReviewService implements ReviewService {
  async review(pack: EvidencePack): Promise<ReviewResult> {
    const has = (rule: string) => pack.events.some((item) => item.ruleId === rule);
    const matching = (rule: string) => pack.events.filter((item) => item.ruleId === rule);
    const mainRisks = pack.events.filter((item) => ["portfolio.max_effective_exposure", "portfolio.max_theme_concentration", "position.max_weight", "data_quality.quote_stale", "data_quality.position_unreconciled"].includes(item.ruleId)).map((item) => ({ title: item.title, explanation: item.message, severity: item.severity, evidenceIds: item.evidenceIds }));
    const planViolations = matching("plan.max_position").map((item) => ({ title: item.title, detail: item.message, evidenceIds: item.evidenceIds }));
    const facts = [
      has("portfolio.max_effective_exposure") ? "有效敞口超过规则上限" : null,
      has("portfolio.max_theme_concentration") ? "主题风险出现集中" : null,
      has("position.max_weight") ? "存在单标的仓位超限" : null,
      has("data_quality.quote_stale") ? "行情过期使估值只能作为警示" : null,
      has("data_quality.position_unreconciled") ? "持仓尚未完成券商对账" : null,
    ].filter(Boolean);
    return {
      mode: "mock",
      summary: facts.length ? `本轮 Evidence Pack 显示：${facts.join("；")}。复盘只引用本轮账本、报价、规则与对账证据。` : "本轮 Evidence Pack 未触发重点风险规则，但仍应核对交易与行情完整性。",
      mainRisks,
      planViolations,
      operationReview: pack.events.filter((item) => item.ruleId === "position.max_weight").map((item) => ({ category: "仓位纪律", observation: item.message, evidenceIds: item.evidenceIds })),
      counterfactuals: ["如果不持有超出计划的仓位，有效敞口会下降多少？", "如果只使用新鲜且已对账的数据，当前结论是否仍然成立？"],
      unknowns: pack.warnings,
      questionsForUser: ["券商当前数量是否已与交易账本逐项核对？"],
      limitations: ["当前为 Mock Review；文本由 Evidence Pack 中的事件组合生成，不调用真实 LLM。", ...(!pack.reliable ? ["数据质量警告存在，复盘不得视为完全可靠。"] : [])],
    };
  }
}
