import type { AgentNarration, AgentObservation, AskScope, ConfirmedContext, MarketAgentCommand, NarrationProvenance, NarrationValidationCategory, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
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

export interface GatewayNarrationSelection {
  provider: string;
  model: string;
  fallbackIndex: number;
  gatewayRequestId: string;
}

const GATEWAY_SELECTION = "__zxlabGatewaySelection";

export function withGatewaySelection(narration: unknown, selection: GatewayNarrationSelection): unknown {
  if (!narration || typeof narration !== "object" || Array.isArray(narration)) return narration;
  return { ...narration, [GATEWAY_SELECTION]: selection };
}

export class DeterministicNarrator implements Narrator {
  async narrate(input: NarrationInput): Promise<AgentNarration> {
    const facts = input.evidence.items.filter((item) => item.kind === "market_fact");
    const events = input.evidence.items.filter((item) => item.kind === "market_event");
    const snapshotDiffs = input.evidence.items.filter((item) => item.kind === "snapshot_diff");
    const marketState = deterministicMarketState(input.evidence);
    const eventObservations: AgentObservation[] = events.map((item, index) => {
      const event = item.value as { instrumentId: string | null; kind: string; actual: number | string | null };
      const direction = event.kind === "price_rise" ? "上涨" : event.kind === "price_fall" ? "下跌" : "出现变化";
      return { id: `deterministic-${index}`, class: item.reliable ? "fact" : "unknown", importance: Math.abs(Number(event.actual ?? 0)) >= 1000 ? "high" : "medium", title: `${event.instrumentId ?? "标的"} ${direction}`, explanation: item.reliable ? `确定性规则检测到 ${String(event.actual ?? "未知")} bps 的价格变化。` : `规则检测到 ${String(event.actual ?? "未知")} bps 的价格变化，但底层行情不可靠，当前只能标记为未知。`, evidenceIds: [item.id] };
    });
    const factObservations = facts
      .filter((item) => input.workflow === "ask" || record(item.value)?.type === "quote")
      .slice(0, input.workflow === "ask" ? 24 : 12)
      .flatMap((item, index) => askFactObservation(item, index, marketState));
    const diffObservations: AgentObservation[] = snapshotDiffs.flatMap((item, itemIndex) => {
      const value = record(item.value);
      const changes = Array.isArray(value?.changes) ? value.changes : [];
      return changes.slice(0, 12).flatMap((raw, changeIndex) => {
        const change = record(raw);
        if (change?.kind !== "quote_price" || typeof change.instrumentId !== "string") return [];
        const deltaBps = Number(change.deltaBps);
        return [{
          id: `deterministic-diff-${itemIndex}-${changeIndex}`,
          class: item.reliable ? "fact" as const : "unknown" as const,
          importance: Number.isFinite(deltaBps) && Math.abs(deltaBps) >= 1000 ? "high" as const : "medium" as const,
          title: `${change.instrumentId} 较上次冻结快照发生变化`,
          explanation: item.reliable && Number.isFinite(deltaBps) ? `确定性差分为 ${deltaBps} bps。` : "冻结快照存在变化，但底层数据质量不足，当前只能标记为未知。",
          evidenceIds: [item.id],
        }];
      });
    });
    const observations = [...factObservations, ...diffObservations, ...eventObservations];
    const portfolioImpacts: AgentObservation[] = input.evidence.items.flatMap((item, index) => {
      const value = item.value as { type?: unknown; impact?: { marketValue?: unknown; unrealizedPnl?: unknown; concentration?: unknown } };
      if (item.kind !== "portfolio_impact" || !item.reliable || value.type !== "risk_impact" || !value.impact) return [];
      const marketValue = Number(value.impact.marketValue);
      const unrealizedPnl = Number(value.impact.unrealizedPnl);
      return [{ id: `deterministic-portfolio-${index}`, class: "fact", importance: "medium", title: "本地持仓风险快照已重估", explanation: `服务端已按当前可靠行情完成持仓重估；估算市值 ${Number.isFinite(marketValue) ? marketValue.toFixed(2) : "未知"}，未实现盈亏 ${Number.isFinite(unrealizedPnl) ? unrealizedPnl.toFixed(2) : "未知"}。`, evidenceIds: [item.id] }];
    });
    const declaredLimitations = input.evidence.items.filter((item) => item.kind === "limitation");
    const declaredMessages = declaredLimitations.flatMap((item) => limitationMessages(item.value));
    const limitations = [...new Set([
      ...(facts.some(materiallyUnreliableFact) && !marketState.warnings.length && !declaredMessages.length ? ["部分必要市场事实暂不可用，本次结果仅覆盖可验证内容。"] : []),
      ...(marketState.claimPolicy === "current-price-claims-forbidden" ? ["当前行情鲜度或交易时段状态不足，不得将最近观测值表述为当前价格。"] : []),
      ...marketState.warnings.map((warning) => `数据限制：${warning}`),
      ...declaredMessages,
    ])];
    const label = input.workflow === "ask"
      ? `受限问答：${askScopeLabel(input.askScope)}`
      : input.workflow === "morning_brief"
        ? "盘前简报"
        : "收盘复盘";
    return { status: limitations.length ? "partial" : "success", headline: events.length ? `${label}检测到确定性事件` : `${label}没有检测到显著事件`, summary: facts.length ? `本次${input.workflow === "ask" ? "回答" : "简报"}仅依据已封存的市场事实与规则事件${portfolioImpacts.length ? "，并纳入已重新估值的本地持仓快照" : ""}。` : "当前没有可用的市场事实。", observations, portfolioImpacts, watchNext: [], limitations, evidenceFingerprint: input.evidence.fingerprint };
  }
}

function materiallyUnreliableFact(item: SealedEvidenceBundle["items"][number]): boolean {
  if (item.reliable) return false;
  const value = record(item.value);
  const warnings = Array.isArray(value?.warnings) ? value.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  return !((value?.evidenceType === "news" || value?.evidenceType === "announcement")
    && warnings.length > 0
    && warnings.every((warning) => warning === "external_text_is_untrusted"));
}

function limitationMessages(value: unknown): string[] {
  const limitation = record(value);
  if (!limitation) return [];
  const warnings = Array.isArray(limitation.warnings)
    ? limitation.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  if (warnings.length) return warnings.map((warning) => `数据限制：${warning}`);
  if (typeof limitation.limitation === "string") return [`数据限制：${limitation.limitation}`];
  if (limitation.status === "unavailable" && typeof limitation.capability === "string") return [`数据能力暂不可用：${limitation.capability}`];
  return [];
}

export async function narrateWithRepair(narrator: Narrator, input: NarrationInput & { repair?: (issues: string[]) => Promise<unknown> }): Promise<{ result: AgentNarration; repaired: boolean; issues: string[]; provenance: NarrationProvenance }> {
  let candidate: unknown;
  try { candidate = await narrator.narrate(input); }
  catch (error) {
    const category = gatewayFailureCategory(error);
    const fallback = await new DeterministicNarrator().narrate(input);
    return {
      result: { ...fallback, status: "partial", limitations: [...fallback.limitations, `Gateway 暂不可用（${category}），已降级为确定性结果。`] },
      repaired: false,
      issues: [`gateway unavailable: ${category}`],
      provenance: { source: "deterministic_fallback", failure: gatewayFailure(error) },
    };
  }
  let unwrapped = unwrapGatewayCandidate(candidate);
  let issues = validateNarration(unwrapped.narration, input, Boolean(unwrapped.selection));
  if (!issues.length) return { result: unwrapped.narration as AgentNarration, repaired: false, issues, provenance: modelProvenance("model", unwrapped.selection) };
  const repair = input.repair ?? (narrator.repair ? (repairIssues: string[]) => narrator.repair!({ ...input, issues: repairIssues }) : undefined);
  if (repair) {
    try {
      candidate = await repair(issues);
      unwrapped = unwrapGatewayCandidate(candidate);
      issues = validateNarration(unwrapped.narration, input, Boolean(unwrapped.selection));
      if (!issues.length) return { result: unwrapped.narration as AgentNarration, repaired: true, issues, provenance: modelProvenance("model_repaired", unwrapped.selection) };
    } catch {
      issues = [...issues, "repair unavailable"];
    }
  }
  const fallback = await new DeterministicNarrator().narrate(input);
  return {
    result: { ...fallback, status: "partial", limitations: [...fallback.limitations, "叙事输出未通过安全校验，已降级为确定性结果。"] },
    repaired: Boolean(repair),
    issues,
    provenance: {
      source: "deterministic_fallback",
      ...(unwrapped.selection ?? {}),
      failure: {
        stage: "validation",
        code: "NARRATION_VALIDATION_FAILED",
        retryable: false,
        validationCategories: validationCategories(issues),
      },
    },
  };
}

function validationCategories(issues: string[]): NarrationValidationCategory[] {
  const categories = issues.map<NarrationValidationCategory>((issue) => {
    if (issue === "trading instructions are forbidden") return "trading_policy";
    if (issue.startsWith("summary must contain 2 to 4 sentences")) return "summary_length";
    if (issue.startsWith("output must not reproduce confirmed context")) return "context_leakage";
    if (issue.includes("numeric claims must match sealed deterministic facts")) return "numeric_grounding";
    if (issue.includes("fact cannot cite unreliable evidence")) return "evidence_reliability";
    if (issue.includes("material evidence limitations")) return "material_limitations";
    if (issue === "repair unavailable") return "repair_unavailable";
    if (issue.includes("evidence absent from the narration context") || issue.includes("must cite presented evidence")) return "citation_scope";
    if (/^(?:narration|status|headline|summary|evidenceFingerprint|conclusionEvidenceIds|observations|portfolioImpacts|watchNext|limitations)/.test(issue)) return "schema";
    return "unknown";
  });
  return [...new Set(categories)];
}

function unwrapGatewayCandidate(candidate: unknown): { narration: unknown; selection?: GatewayNarrationSelection } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { narration: candidate };
  const { [GATEWAY_SELECTION]: rawSelection, ...narration } = candidate as Record<string, unknown>;
  const selection = rawSelection as GatewayNarrationSelection | undefined;
  return { narration, ...(selection ? { selection } : {}) };
}

function modelProvenance(source: "model" | "model_repaired", selection?: GatewayNarrationSelection): NarrationProvenance {
  return { source, ...(selection ?? {}) };
}

function gatewayFailure(error: unknown): NonNullable<NarrationProvenance["failure"]> {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("NOT_CONFIGURED")) return { stage: "configuration", code: "GATEWAY_NOT_CONFIGURED", retryable: false };
  if (message.includes("ALL_CANDIDATES_FAILED")) return { stage: "gateway", code: "ALL_CANDIDATES_FAILED", retryable: true };
  if (message.includes("CONTEXT_TOO_LONG")) return { stage: "gateway", code: "CONTEXT_TOO_LONG", retryable: false };
  if (message.includes("INVALID_JSON") || message.includes("STREAM_INCOMPLETE") || message.includes("RESPONSE_TOO_LARGE")) return { stage: "protocol", code: "GATEWAY_PROTOCOL_ERROR", retryable: true };
  if (/HTTP_(401|403)(?:_|$)/.test(message)) return { stage: "gateway", code: "GATEWAY_UNAUTHORIZED", retryable: false };
  if (/HTTP_429(?:_|$)/.test(message)) return { stage: "gateway", code: "GATEWAY_RATE_LIMITED", retryable: true };
  if (/HTTP_5\d\d(?:_|$)/.test(message) || message.includes("TIMEOUT")) return { stage: "gateway", code: "GATEWAY_UNAVAILABLE", retryable: true };
  return { stage: "gateway", code: "GATEWAY_CONNECTION_FAILED", retryable: true };
}

function gatewayFailureCategory(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (error instanceof DOMException && error.name === "TimeoutError" || code.includes("TIMEOUT")) return "请求超时";
  if (/HTTP_(401|403)(?:_|$)/.test(code) || code.includes("UNAUTHORIZED") || code.includes("FORBIDDEN")) return "鉴权失败";
  if (/HTTP_429(?:_|$)/.test(code) || code.includes("RATE_LIMIT")) return "请求限流";
  if (code.includes("CONTEXT_TOO_LONG")) return "上下文超出限制";
  if (code.includes("INVALID_INPUT")) return "请求格式不兼容";
  if (code.includes("ALL_CANDIDATES_FAILED")) return "模型候选均失败";
  if (code.includes("NOT_CONFIGURED")) return "服务配置缺失";
  if (code.includes("INVALID_JSON") || code.includes("STREAM_INCOMPLETE") || code.includes("RESPONSE_TOO_LARGE")) return "响应协议异常";
  if (/HTTP_5\d\d(?:_|$)/.test(code)) return "上游服务异常";
  return "连接异常";
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
    return [{
      id: `deterministic-ask-quote-${index}`,
      class: item.reliable ? "fact" : "unknown",
      importance: "medium",
      title: `${value.instrumentId} 行情事实`,
      explanation: price === null ? "当前报价不可用。" : `${priceDescription(marketState, item.reliable)} ${price.toFixed(2)}。变化幅度没有由已封存的确定性算子直接提供，因此不在这里补算。`,
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

function validateNarration(value: unknown, input: NarrationInput, selectedGatewayModel = false): string[] {
  const evidence = input.evidence;
  const issues = validateAgentNarration(value, evidence);
  const candidate = record(value);
  if (!candidate) return issues;
  if (selectedGatewayModel && (typeof candidate.summary !== "string" || sentenceCount(candidate.summary) < 2 || sentenceCount(candidate.summary) > 4)) {
    issues.push("summary must contain 2 to 4 sentences for a selected Gateway model");
  }
  const contextLeak = contextLeakIssue(candidate, input.confirmedContext ?? []);
  if (contextLeak) issues.push(contextLeak);
  const evidenceById = new Map(evidence.items.map((item) => [item.id, item]));
  const presentedEvidence = buildNarrationContext({ evidence, workflow: input.workflow, askScope: input.askScope }).evidence;
  const presentedEvidenceIds = new Set(presentedEvidence.map((item) => item.id));
  if (Array.isArray(candidate.conclusionEvidenceIds) && candidate.conclusionEvidenceIds.some((id) => typeof id === "string" && !presentedEvidenceIds.has(id))) {
    issues.push("conclusionEvidenceIds cite evidence absent from the narration context");
  }
  issues.push(...ungroundedNumericClaimIssues(candidate, evidenceById, presentedEvidence));
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

function ungroundedNumericClaimIssues(
  candidate: Record<string, unknown>,
  evidenceById: Map<string, SealedEvidenceBundle["items"][number]>,
  presentedEvidence: ReturnType<typeof buildNarrationContext>["evidence"],
): string[] {
  const presentedById = new Map(presentedEvidence.map((item) => [item.id, item]));
  const observations = arrayRecords(candidate.observations);
  const portfolioImpacts = arrayRecords(candidate.portfolioImpacts);
  const watchNext = arrayRecords(candidate.watchNext);
  const conclusionEvidenceIds = Array.isArray(candidate.conclusionEvidenceIds)
    ? candidate.conclusionEvidenceIds.filter((id): id is string => typeof id === "string")
    : [];
  const sections = [
    { path: "narration", text: strings(candidate.headline, candidate.summary), evidenceIds: conclusionEvidenceIds },
    ...observations.map((item, index) => ({ path: `observations[${index}]`, text: strings(item.title, item.explanation), evidenceIds: evidenceIds(item) })),
    ...portfolioImpacts.map((item, index) => ({ path: `portfolioImpacts[${index}]`, text: strings(item.title, item.explanation), evidenceIds: evidenceIds(item) })),
    ...watchNext.map((item, index) => ({ path: `watchNext[${index}]`, text: strings(item.condition, item.reason), evidenceIds: evidenceIds(item) })),
    { path: "limitations", text: Array.isArray(candidate.limitations) ? strings(...candidate.limitations) : "", evidenceIds: [] },
  ];
  return sections.flatMap((section) => {
    const claims = [...numericTokens(section.text)];
    const chineseClaims = chineseQuantityTokens(section.text);
    if (!claims.length && !chineseClaims.length) return [];
    const supported = new Set(section.evidenceIds.flatMap((evidenceId) => {
      const sealed = evidenceById.get(evidenceId);
      const presented = presentedById.get(evidenceId);
      if (!sealed?.reliable || !presented) return [];
      return claimableNumericTokens(sealed.kind, presented.value);
    }));
    const unsupported = [
      ...claims.filter((claim) => ![...supported].some((value) => sameNumericToken(value, claim))),
      ...chineseClaims,
    ];
    return unsupported.length ? [`${section.path} numeric claims must match sealed deterministic facts: ${unsupported.join(", ")}`] : [];
  });
}

function claimableNumericTokens(kind: SealedEvidenceBundle["items"][number]["kind"], value: Record<string, unknown>): string[] {
  if (kind === "market_event") {
    return [...numericValues(value, ["actual", "threshold"]), ...decimalStrings(value.actual, value.threshold)];
  }
  if (kind === "snapshot_diff") {
    const changes = Array.isArray(value.changes) ? value.changes.flatMap((change) => record(change) ? [record(change)!] : []) : [];
    return changes.flatMap((change) => numericValues(change, ["previous", "current", "delta", "deltaBps"]));
  }
  if (kind === "portfolio_impact" && value.type === "risk_impact") {
    const impact = record(value.impact);
    if (!impact) return [];
    const concentration = Array.isArray(impact.concentration) ? impact.concentration.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
    return [
      ...numericValues(impact, ["marketValue", "costBasis", "unrealizedPnl"]),
      ...concentration.flatMap((entry) => numericValues(entry, ["weight"])),
    ];
  }
  if (kind !== "market_fact") return [];
  if (value.type === "quote") {
    const corroboration = record(value.corroboration);
    const observations = Array.isArray(corroboration?.observations) ? corroboration.observations.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
    return [
      ...numericValues(value, ["price", "previousClose", "open", "high", "low", "volume", "turnover"]),
      ...(corroboration ? numericValues(corroboration, ["thresholdBps", "maxDeviationBps"]) : []),
      ...observations.flatMap((entry) => numericValues(entry, ["price"])),
    ];
  }
  if (value.type === "bar_series_summary") {
    const bars = [record(value.first), record(value.previous), record(value.latest)].filter((bar): bar is Record<string, unknown> => Boolean(bar));
    const trailingCloses = Array.isArray(value.trailingCloses) ? value.trailingCloses.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
    return [
      ...bars.flatMap((bar) => numericValues(bar, ["open", "high", "low", "close", "volume", "turnover"])),
      ...trailingCloses.flatMap((entry) => numericValues(entry, ["close"])),
    ];
  }
  if (value.type === "research_fact") {
    const fact = record(value.fact);
    if (!fact) return [];
    const factValue = record(fact.value);
    const weight = record(fact.weight);
    const comparison = record(fact.comparison);
    const historicalPercentile = record(fact.historicalPercentile);
    const observationPeriod = record(fact.observationPeriod);
    const quality = record(fact.quality);
    const coverage = record(quality?.coverage);
    return [
      ...numericValues(fact, ["window"]),
      ...(observationPeriod ? numericValues(observationPeriod, ["tradingSessions"]) : []),
      ...(coverage ? numericValues(coverage, ["actual", "required"]) : []),
      ...decimalStrings(factValue?.decimal, weight?.decimal, comparison?.decimal, historicalPercentile?.decimal),
    ];
  }
  return [];
}

function numericValues(value: Record<string, unknown>, keys: string[]): string[] {
  return keys.flatMap((key) => typeof value[key] === "number" && Number.isFinite(value[key]) ? [String(value[key])] : []);
}

function decimalStrings(...values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value));
}

function evidenceIds(value: Record<string, unknown>): string[] {
  return Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((id): id is string => typeof id === "string") : [];
}

function strings(...values: unknown[]): string {
  return values.filter((value): value is string => typeof value === "string").join("\n");
}

function sentenceCount(value: string): number {
  return value.trim().split(/[。！？!?]+/u).filter((sentence) => sentence.trim().length > 0).length;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => record(item) ? [record(item)!] : []) : [];
}

function numericTokens(value: string): Set<string> {
  const withoutIdentifiers = value.replace(/\b(?:SSE|SZSE):\d{6}\b/giu, "");
  return new Set(withoutIdentifiers.match(/[-+]?\d[\d,]*(?:\.\d+)?(?:[%％])?/g)?.map((token) => token.replaceAll(",", "")) ?? []);
}

function chineseQuantityTokens(value: string): string[] {
  return [...new Set(value.match(/[零〇一二两三四五六七八九十百千万亿]+(?:个百分点|基点|季度|月份|bps|[个只条项次日天周月年股倍成点元手%％])/giu) ?? [])];
}

function sameNumericToken(left: string, right: string): boolean {
  const leftPercent = /[%％]$/.test(left);
  const rightPercent = /[%％]$/.test(right);
  if (leftPercent !== rightPercent) return false;
  const leftNumber = Number(left.replace(/[%％]$/, ""));
  const rightNumber = Number(right.replace(/[%％]$/, ""));
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
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
