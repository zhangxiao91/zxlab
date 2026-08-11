import type { AgentNarration, AgentObservation, AskScope, ConfirmedContext, MarketAgentCommand, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { validateAgentNarration } from "@zxlab/market-agent-schema";
import { buildNarrationContext } from "./narration-context.ts";

export interface NarrationInput {
  workflow: MarketAgentCommand["workflow"];
  evidence: SealedEvidenceBundle;
  askScope?: AskScope;
  /** Untrusted wording only. It never changes the sealed scope or evidence. */
  question?: string;
  /** Ephemeral canonical context. It must never be persisted or quoted in the result. */
  confirmedContext?: ConfirmedContext[];
}

export interface Narrator {
  narrate(input: NarrationInput): Promise<unknown>;
  repair?(input: NarrationInput & { issues: string[] }): Promise<unknown>;
}

export class DeterministicNarrator implements Narrator {
  async narrate(input: NarrationInput): Promise<AgentNarration> {
    const facts = input.evidence.items.filter((item) => item.kind === "market_fact");
    const events = input.evidence.items.filter((item) => item.kind === "market_event");
    const marketState = deterministicMarketState(input.evidence);
    const eventObservations: AgentObservation[] = events.map((item, index) => {
      const event = item.value as { instrumentId: string | null; kind: string; actual: number | string | null };
      const direction = event.kind === "price_rise" ? "上涨" : event.kind === "price_fall" ? "下跌" : "出现变化";
      return { id: `deterministic-${index}`, class: item.reliable ? "fact" : "unknown", importance: Math.abs(Number(event.actual ?? 0)) >= 1000 ? "high" : "medium", title: `${event.instrumentId ?? "标的"} ${direction}`, explanation: item.reliable ? `确定性规则检测到 ${String(event.actual ?? "未知")} bps 的价格变化。` : `规则检测到 ${String(event.actual ?? "未知")} bps 的价格变化，但底层行情不可靠，当前只能标记为未知。`, evidenceIds: [item.id] };
    });
    const factObservations = input.workflow === "ask"
      ? facts.slice(0, 24).flatMap((item, index) => askFactObservation(item, index, marketState))
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
    const limitations = [...new Set([
      ...(facts.some((item) => !item.reliable) ? ["部分市场事实不可靠，结果仅供观察，不能视为完整复盘。"] : []),
      ...(marketState.claimPolicy === "current-price-claims-forbidden" ? ["当前行情鲜度或交易时段状态不足，不得将最近观测值表述为当前价格。"] : []),
      ...marketState.warnings.map((warning) => `行情限制：${warning}`),
      ...declaredLimitations.map((item) => `证据限制：${JSON.stringify(item.value)}`),
    ])];
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
  let issues = validateNarration(candidate, input);
  if (!issues.length) return { result: candidate as AgentNarration, repaired: false, issues };
  const repair = input.repair ?? (narrator.repair ? (repairIssues: string[]) => narrator.repair!({ ...input, issues: repairIssues }) : undefined);
  if (repair) {
    try {
      candidate = await repair(issues);
      issues = validateNarration(candidate, input);
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

function askFactObservation(
  item: SealedEvidenceBundle["items"][number],
  index: number,
  marketState: ReturnType<typeof deterministicMarketState>,
): AgentObservation[] {
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
      explanation: price === null ? "当前报价不可用。" : `${priceDescription(marketState, item.reliable)} ${price.toFixed(2)}${movement}。`,
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

function validateNarration(value: unknown, input: NarrationInput): string[] {
  const evidence = input.evidence;
  const issues = validateAgentNarration(value, evidence);
  const candidate = record(value);
  if (!candidate) return issues;
  const contextLeak = contextLeakIssue(candidate, input.confirmedContext ?? []);
  if (contextLeak) issues.push(contextLeak);
  const evidenceById = new Map(evidence.items.map((item) => [item.id, item]));
  const presentedEvidenceIds = new Set(buildNarrationContext({ evidence, workflow: input.workflow, askScope: input.askScope }).evidence.map((item) => item.id));
  const materialLimitations = evidence.items.some((item) => item.kind === "limitation" || (item.kind === "market_fact" && !item.reliable));
  if (materialLimitations && candidate.status !== "partial") issues.push("status must be partial when sealed evidence has material limitations");
  if (materialLimitations && (!Array.isArray(candidate.limitations) || candidate.limitations.length === 0)) issues.push("limitations must describe material evidence limitations");
  for (const field of ["observations", "portfolioImpacts"] as const) {
    if (!Array.isArray(candidate[field])) continue;
    for (const [index, observationValue] of candidate[field].entries()) {
      const observation = record(observationValue);
      if (!observation || !Array.isArray(observation.evidenceIds)) continue;
      if (observation.class === "fact" && observation.evidenceIds.some((id) => typeof id === "string" && evidenceById.get(id)?.reliable === false)) {
        issues.push(`${field}[${index}] fact cannot cite unreliable evidence`);
      }
      if (observation.evidenceIds.some((id) => typeof id === "string" && !presentedEvidenceIds.has(id))) {
        issues.push(`${field}[${index}] cites evidence absent from the narration context`);
      }
    }
  }
  if (Array.isArray(candidate.watchNext)) {
    for (const [index, watchValue] of candidate.watchNext.entries()) {
      const watch = record(watchValue);
      if (!watch || !Array.isArray(watch.evidenceIds) || watch.evidenceIds.length === 0) {
        issues.push(`watchNext[${index}] must cite presented evidence`);
        continue;
      }
      if (watch.evidenceIds.some((id) => typeof id !== "string" || !evidenceById.has(id) || !presentedEvidenceIds.has(id))) {
        issues.push(`watchNext[${index}] cites evidence absent from the narration context`);
      }
    }
  }
  return [...new Set(issues)];
}

function contextLeakIssue(value: Record<string, unknown>, contexts: ConfirmedContext[]): string | null {
  const serialized = normalizeText(JSON.stringify(value));
  for (const context of contexts) {
    const content = normalizeText(context.content);
    if (content.length >= 24 && serialized.includes(content)) return `output must not reproduce confirmed context ${context.memoryId}`;
  }
  return null;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function deterministicMarketState(evidence: SealedEvidenceBundle): {
  sessions: string[];
  freshness: string;
  reliable: boolean;
  warnings: string[];
  claimPolicy: "live-if-fresh" | "last-observed-not-live" | "current-price-claims-forbidden";
} {
  const context = evidence.items.map((item) => record(item.value)).find((value) => value?.type === "snapshot_context");
  const quality = record(context?.quality);
  const markets = Array.isArray(context?.markets) ? context.markets.flatMap((value) => record(value) ? [record(value)!] : []) : [];
  const sessions = [...new Set(markets.flatMap((market) => typeof market.session === "string" ? [market.session] : []))].sort();
  const freshness = typeof quality?.freshness === "string" ? quality.freshness : "unknown";
  const reliable = typeof quality?.reliable === "boolean" ? quality.reliable : !evidence.items.some((item) => item.kind === "market_fact" && !item.reliable);
  const warnings = Array.isArray(quality?.warnings) ? quality.warnings.flatMap((warning) => typeof warning === "string" ? [warning] : []) : [];
  const claimPolicy = !reliable || freshness === "stale" || freshness === "unknown" || sessions.length === 0 || sessions.includes("unknown")
    ? "current-price-claims-forbidden"
    : sessions.length === 1 && sessions[0] === "open" && freshness === "fresh"
      ? "live-if-fresh"
      : "last-observed-not-live";
  return { sessions, freshness, reliable, warnings, claimPolicy };
}

function priceDescription(state: ReturnType<typeof deterministicMarketState>, reliable: boolean): string {
  if (!reliable || state.claimPolicy === "current-price-claims-forbidden") return "仅供参考的最近观测价";
  if (state.sessions.includes("closed")) return "闭市后的最近观测价";
  if (state.sessions.includes("holiday")) return "休市期间的最近观测价";
  if (state.sessions.includes("break")) return "午间休市时的最近观测价";
  if (state.sessions.includes("preopen")) return "盘前最近可用价";
  return "开盘时段最新可用价";
}
