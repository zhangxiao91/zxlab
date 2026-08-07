import type { AgentNarration, AgentObservation, AskScope, MarketAgentCommand, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { validateAgentNarration } from "@zxlab/market-agent-schema";

export interface NarrationInput {
  workflow: MarketAgentCommand["workflow"];
  evidence: SealedEvidenceBundle;
  askScope?: AskScope;
  /** Untrusted wording only. It never changes the sealed scope or evidence. */
  question?: string;
}

export interface Narrator {
  narrate(input: NarrationInput): Promise<unknown>;
  repair?(input: NarrationInput & { issues: string[] }): Promise<unknown>;
}

export class DeterministicNarrator implements Narrator {
  async narrate(input: NarrationInput): Promise<AgentNarration> {
    const facts = input.evidence.items.filter((item) => item.kind === "market_fact");
    const events = input.evidence.items.filter((item) => item.kind === "market_event");
    const eventObservations: AgentObservation[] = events.map((item, index) => {
      const event = item.value as { instrumentId: string | null; kind: string; actual: number | string | null };
      const direction = event.kind === "price_rise" ? "上涨" : event.kind === "price_fall" ? "下跌" : "出现变化";
      return { id: `deterministic-${index}`, class: "fact", importance: Math.abs(Number(event.actual ?? 0)) >= 1000 ? "high" : "medium", title: `${event.instrumentId ?? "标的"} ${direction}`, explanation: `确定性规则检测到 ${String(event.actual ?? "未知")} bps 的价格变化。`, evidenceIds: [item.id] };
    });
    const factObservations = input.workflow === "ask"
      ? facts.slice(0, 12).flatMap((item, index) => askFactObservation(item, index))
      : [];
    const observations = input.workflow === "ask"
      ? [...factObservations, ...eventObservations]
      : eventObservations;
    const portfolioImpacts: AgentObservation[] = input.evidence.items.flatMap((item, index) => {
      const value = item.value as { type?: unknown; impact?: { marketValue?: unknown; unrealizedPnl?: unknown; concentration?: unknown } };
      if (item.kind !== "portfolio_impact" || !item.reliable || value.type !== "risk_impact" || !value.impact) return [];
      const marketValue = Number(value.impact.marketValue);
      const unrealizedPnl = Number(value.impact.unrealizedPnl);
      const concentrationCount = Array.isArray(value.impact.concentration) ? value.impact.concentration.length : 0;
      return [{ id: `deterministic-portfolio-${index}`, class: "fact", importance: "medium", title: "本地持仓风险快照已重估", explanation: `服务端已按当前可靠行情重估 ${concentrationCount} 个持仓；估算市值 ${Number.isFinite(marketValue) ? marketValue.toFixed(2) : "未知"}，未实现盈亏 ${Number.isFinite(unrealizedPnl) ? unrealizedPnl.toFixed(2) : "未知"}。`, evidenceIds: [item.id] }];
    });
    const declaredLimitations = input.evidence.items.filter((item) => item.kind === "limitation");
    const limitations = [...(facts.some((item) => !item.reliable) ? ["部分市场事实不可靠，结果仅供观察，不能视为完整复盘。"] : []), ...declaredLimitations.map((item) => `证据限制：${JSON.stringify(item.value)}`)];
    const label = input.workflow === "ask"
      ? `受限问答：${askScopeLabel(input.askScope)}`
      : input.workflow === "morning_brief"
        ? "盘前简报"
        : "收盘复盘";
    return { status: limitations.length ? "partial" : "success", headline: events.length ? `${label}检测到 ${events.length} 个确定性事件` : `${label}没有检测到显著事件`, summary: facts.length ? `本次${input.workflow === "ask" ? "回答" : "简报"}基于 ${facts.length} 条市场事实、${events.length} 个规则事件${portfolioImpacts.length ? "和已重新估值的本地持仓快照" : ""}。` : "当前没有可用的市场事实。", observations, portfolioImpacts, watchNext: [], limitations, evidenceFingerprint: input.evidence.fingerprint };
  }
}

export async function narrateWithRepair(narrator: Narrator, input: NarrationInput & { repair?: (issues: string[]) => Promise<unknown> }): Promise<{ result: AgentNarration; repaired: boolean; issues: string[] }> {
  let candidate: unknown;
  try { candidate = await narrator.narrate(input); }
  catch { const fallback = await new DeterministicNarrator().narrate(input); return { result: { ...fallback, status: "partial", limitations: [...fallback.limitations, "Gateway 暂不可用，已降级为确定性结果。"] }, repaired: false, issues: ["gateway unavailable"] }; }
  let issues = validateAgentNarration(candidate, input.evidence);
  if (!issues.length) return { result: candidate as AgentNarration, repaired: false, issues };
  const repair = input.repair ?? (narrator.repair ? (repairIssues: string[]) => narrator.repair!({ ...input, issues: repairIssues }) : undefined);
  if (repair) {
    try {
      candidate = await repair(issues);
      issues = validateAgentNarration(candidate, input.evidence);
      if (!issues.length) return { result: candidate as AgentNarration, repaired: true, issues };
    } catch {
      issues = [...issues, "repair unavailable"];
    }
  }
  const fallback = await new DeterministicNarrator().narrate(input);
  return { result: { ...fallback, status: "partial", limitations: [...fallback.limitations, "叙事输出未通过安全校验，已降级为确定性结果。"] }, repaired: Boolean(repair), issues };
}

function askScopeLabel(scope: AskScope | undefined): string {
  return {
    today_change: "今日变化",
    relative_performance: "相对观察列表表现",
    news_and_announcements: "新闻与公告",
    data_quality: "数据质量",
    portfolio_impact: "持仓影响",
    compare_previous_run: "与上次运行比较",
  }[scope ?? "today_change"];
}

function askFactObservation(item: SealedEvidenceBundle["items"][number], index: number): AgentObservation[] {
  const value = record(item.value);
  if (!value) return [];
  if (value.type === "quote" && typeof value.instrumentId === "string") {
    const price = finiteNumber(value.price);
    const previousClose = finiteNumber(value.previousClose);
    const movement = price !== null && previousClose !== null && previousClose !== 0
      ? `，较昨收 ${(100 * (price - previousClose) / previousClose).toFixed(2)}%`
      : "";
    return [{
      id: `deterministic-ask-quote-${index}`,
      class: item.reliable ? "fact" : "unknown",
      importance: "medium",
      title: `${value.instrumentId} 行情事实`,
      explanation: price === null ? "当前报价不可用。" : `最新价 ${price.toFixed(2)}${movement}。`,
      evidenceIds: [item.id],
    }];
  }
  if ((value.evidenceType === "news" || value.evidenceType === "announcement") && typeof value.title === "string") {
    return [{
      id: `deterministic-ask-news-${index}`,
      class: item.reliable ? "fact" : "unknown",
      importance: "low",
      title: value.title,
      explanation: value.evidenceType === "announcement" ? "服务端已收集该公告元数据。" : "服务端已收集该新闻元数据。",
      evidenceIds: [item.id],
    }];
  }
  return [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
