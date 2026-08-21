import type { AgentNarration, AgentObservation, AskScope, ConfirmedContext, EvidenceAssessment, MarketAgentCommand, NarrationProvenance, NarrationValidationCategory, NarrationValidationRule, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { validateAgentNarration } from "@zxlab/market-agent-schema";
import { buildNarrationContext } from "./narration-context.ts";
import { resolveNarrativeDepthPolicy, validateNarrativeDepth } from "./narrative-depth.ts";

export interface NarrationInput {
  workflow: MarketAgentCommand["workflow"];
  evidence: SealedEvidenceBundle;
  askScope?: AskScope;
  /** The same authoritative assessment persisted in RunOutcome. */
  evidenceAssessment?: EvidenceAssessment;
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
    const factObservations = facts.flatMap((item, index) => askFactObservation(item, index, marketState));
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
          explanation: item.reliable && Number.isFinite(deltaBps) ? `服务端对前后两份冻结快照执行了同口径差分，确定性变化为 ${deltaBps} bps；该结果来自已封存算子，不由模型补算。` : "冻结快照存在变化，但底层数据质量不足，当前只能标记为未知；后续需要新的可靠快照才能复核该变化。",
          evidenceIds: [item.id],
        }];
      });
    });
    const basisObservations = diverseDeterministicBasis(factObservations, diffObservations, eventObservations);
    const analysisObservations: AgentObservation[] = basisObservations.filter((item) => item.class === "fact").length >= 2
      ? [{
          id: "deterministic-cross-evidence-analysis",
          class: "inference",
          importance: "medium",
          title: "多类证据需要合并解读",
          explanation: "多项已封存事实共同构成当前观察的依据，因此单一变化不宜脱离历史或持仓语境解释；这种定性含义仍可能被后续市场事实改变，尚无法确认其持续性。",
          evidenceIds: basisObservations.slice(0, 2).flatMap((item) => item.evidenceIds),
        }]
      : [];
    const observations = [...basisObservations, ...analysisObservations].slice(0, 6);
    const portfolioImpacts: AgentObservation[] = input.evidence.items.flatMap((item, index) => {
      const value = item.value as { type?: unknown; impact?: { marketValue?: unknown; unrealizedPnl?: unknown; concentration?: unknown } };
      if (item.kind !== "portfolio_impact" || !item.reliable || value.type !== "risk_impact" || !value.impact) return [];
      const marketValue = Number(value.impact.marketValue);
      const unrealizedPnl = Number(value.impact.unrealizedPnl);
      return [{ id: `deterministic-portfolio-${index}`, class: "fact", importance: "medium", title: "本地持仓风险快照已重估", explanation: `服务端已按当前可靠行情和固定风险口径完成持仓重估；估算市值 ${Number.isFinite(marketValue) ? marketValue.toFixed(2) : "未知"}，未实现盈亏 ${Number.isFinite(unrealizedPnl) ? unrealizedPnl.toFixed(2) : "未知"}，原始输入与计算结果均保留在所引 Evidence 中。`, evidenceIds: [item.id] }];
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
    const citedEvidenceIds = [...new Set([...observations, ...portfolioImpacts].filter((item) => item.class === "fact").flatMap((item) => item.evidenceIds))].slice(0, 4);
    const watchEvidenceIds = citedEvidenceIds.slice(0, 2);
    const watchNext = watchEvidenceIds.length ? [{
      condition: "关注后续可靠市场事实是否改变当前观察",
      reason: "新的同口径 Evidence 可以复核当前结论是否继续成立，并区分一次性变化与可延续状态。",
      evidenceIds: watchEvidenceIds,
    }] : [];
    const summary = facts.length || observations.length || portfolioImpacts.length
      ? `本次${input.workflow === "ask" ? "回答" : "简报"}仅依据已封存的市场事实、确定性规则与可复核的研究口径形成，不使用模型自行补齐的数据。主文先列出能够直接确认的依据，再说明这些事实为何值得关注${portfolioImpacts.length ? "，并纳入服务端重新估值的本地持仓快照" : ""}。现有解释仍可能被后续市场事实改变，具体数值、观察时间、公式与来源应在所引 Evidence 中核对。`
      : "当前没有可用于形成市场结论的可靠事实，因此本次结果只说明证据边界，不补写缺失信息。后续需要等待服务端取得新的可验证 Evidence，再按相同口径重新运行。任何具体数值、市场状态或变化方向都不应从这份受限结果中推断。";
    return { status: limitations.length ? "partial" : "success", headline: events.length ? `${label}检测到确定性事件` : `${label}形成确定性证据复盘`, summary, conclusionEvidenceIds: citedEvidenceIds, observations, portfolioImpacts, watchNext, limitations, evidenceFingerprint: input.evidence.fingerprint };
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

function diverseDeterministicBasis(facts: AgentObservation[], diffs: AgentObservation[], events: AgentObservation[]): AgentObservation[] {
  const pools = [
    facts.filter((item) => item.id.startsWith("deterministic-ask-quote-")),
    facts.filter((item) => item.id.startsWith("deterministic-ask-bars-")),
    facts.filter((item) => item.id.startsWith("deterministic-research-")),
    diffs,
    events,
    facts.filter((item) => !item.id.startsWith("deterministic-ask-quote-") && !item.id.startsWith("deterministic-ask-bars-") && !item.id.startsWith("deterministic-research-")),
  ];
  const selected: AgentObservation[] = [];
  for (const pool of pools) {
    const candidate = pool.find((item) => !selected.some((selectedItem) => selectedItem.id === item.id));
    if (candidate) selected.push(candidate);
    if (selected.length === 5) return selected;
  }
  for (const candidate of pools.flat()) {
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
    if (selected.length === 5) break;
  }
  return selected;
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
      if (unwrapped.selection && issues.some((issue) => issue.includes("model narration must not contain quantities"))) {
        const qualitative = deterministicallyQualitativeNarration(unwrapped.narration, input);
        issues = validateNarration(qualitative, input, true);
        if (!issues.length) return { result: qualitative as AgentNarration, repaired: true, issues, provenance: modelProvenance("model_repaired", unwrapped.selection) };
      }
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
        validationRuleIds: validationRuleIds(issues),
        numericSections: numericSections(issues),
      },
    },
  };
}

function numericSections(issues: string[]): NonNullable<NonNullable<NarrationProvenance["failure"]>["numericSections"]> {
  const sections = issues.flatMap((issue) => {
    const match = issue.match(/^(narration|observations|portfolioImpacts|watchNext|limitations)(?:\[\d+\])? (?:numeric claims must match sealed deterministic facts|model narration must not contain quantities):/);
    return match ? [match[1] as "narration" | "observations" | "portfolioImpacts" | "watchNext" | "limitations"] : [];
  });
  return [...new Set(sections)];
}

function validationRuleIds(issues: string[]): NarrationValidationRule[] {
  const rules = issues.map<NarrationValidationRule>((issue) => {
    if (/^narration\..+ is not allowed$/.test(issue)) return "unexpected_field";
    if (issue === "status is invalid") return "status_invalid";
    if (issue === "headline is invalid") return "headline_invalid";
    if (issue === "summary is invalid") return "summary_invalid";
    if (issue === "evidenceFingerprint must match sealed evidence") return "fingerprint_mismatch";
    if (issue.startsWith("conclusionEvidenceIds must reference")) return "conclusion_evidence_invalid";
    if (/^(?:observations|portfolioImpacts) must be an array/.test(issue)) return "observation_collection_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.id is invalid$/.test(issue)) return "observation_id_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.class is invalid$/.test(issue)) return "observation_class_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.importance is invalid$/.test(issue)) return "observation_importance_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.title is invalid$/.test(issue)) return "observation_title_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.explanation is invalid$/.test(issue)) return "observation_explanation_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.evidenceIds must reference sealed evidence$/.test(issue)) return "observation_evidence_invalid";
    if (/^(?:observations|portfolioImpacts)\[\d+\]\.inference must use uncertainty language$/.test(issue)) return "observation_uncertainty_missing";
    if (issue.startsWith("watchNext must be an array")) return "watch_collection_invalid";
    if (issue === "limitations must be a bounded string[]") return "limitations_invalid";
    if (issue.startsWith("NARRATION_LIMITATION_UNSUPPORTED")) return "limitation_unsupported";
    if (issue.startsWith("NARRATIVE_DEPTH_SUMMARY_TOO_SHORT")) return "summary_invalid";
    if (issue.startsWith("NARRATIVE_DEPTH_CONCLUSION_EVIDENCE_TOO_SHALLOW")) return "conclusion_evidence_invalid";
    if (issue.startsWith("NARRATIVE_DEPTH_BASIS_TOO_SHALLOW") || issue.startsWith("NARRATIVE_DEPTH_ANALYSIS_TOO_SHALLOW") || issue.startsWith("NARRATIVE_DEPTH_PORTFOLIO_TOO_SHALLOW")) return "observation_collection_invalid";
    if (issue.startsWith("NARRATIVE_DEPTH_WATCH_NEXT_MISSING")) return "watch_collection_invalid";
    if (issue.startsWith("NARRATIVE_DEPTH_REQUIRED_EVIDENCE_UNCOVERED")) return "observation_evidence_invalid";
    if (issue.startsWith("NARRATIVE_DEPTH_REQUIRED_TOPIC_UNCOVERED")) return "observation_evidence_invalid";
    if (issue.startsWith("NARRATIVE_DEPTH_EXPLANATION_TOO_SHORT") || issue.startsWith("NARRATIVE_DEPTH_EXPLANATION_MISSING_SIGNIFICANCE")) return "observation_explanation_invalid";
    if (issue === "trading instructions are forbidden") return "trading_instruction";
    if (issue.startsWith("summary must contain 2 to 4 sentences")) return "summary_sentence_count";
    if (issue.startsWith("output must not reproduce confirmed context")) return "context_leakage";
    if (issue.startsWith("conclusionEvidenceIds cite evidence absent")) return "conclusion_context";
    if (issue.includes("numeric claims must match sealed deterministic facts") || issue.includes("model narration must not contain quantities")) return "numeric_claim";
    if (issue === "status must be partial when sealed evidence has material limitations") return "status_limitation_mismatch";
    if (issue === "limitations must describe material evidence limitations") return "limitation_missing";
    if (issue.includes("fact cannot cite unreliable evidence")) return "unreliable_fact";
    if (/^(?:observations|portfolioImpacts)\[\d+\] cites evidence absent/.test(issue)) return "observation_context";
    if (issue.startsWith("watchNext[") && (issue.includes("must cite presented evidence") || issue.includes("cites evidence absent"))) return "watch_citation";
    if (issue === "repair unavailable") return "repair_unavailable";
    return "unknown";
  });
  return [...new Set(rules)];
}

function validationCategories(issues: string[]): NarrationValidationCategory[] {
  const categories = issues.map<NarrationValidationCategory>((issue) => {
    if (issue === "trading instructions are forbidden") return "trading_policy";
    if (issue.startsWith("NARRATION_LIMITATION_UNSUPPORTED")) return "material_limitations";
    if (issue.startsWith("NARRATIVE_DEPTH_SUMMARY_TOO_SHORT")) return "summary_length";
    if (issue.startsWith("NARRATIVE_DEPTH_REQUIRED_EVIDENCE_UNCOVERED") || issue.startsWith("NARRATIVE_DEPTH_REQUIRED_TOPIC_UNCOVERED")) return "citation_scope";
    if (issue.startsWith("NARRATIVE_DEPTH_")) return "schema";
    if (issue.startsWith("summary must contain 2 to 4 sentences")) return "summary_length";
    if (issue.startsWith("output must not reproduce confirmed context")) return "context_leakage";
    if (issue.includes("numeric claims must match sealed deterministic facts") || issue.includes("model narration must not contain quantities")) return "numeric_grounding";
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
  if (message.includes("INVALID_JSON") || message.includes("INVALID_SELECTION") || message.includes("STREAM_INCOMPLETE") || message.includes("RESPONSE_TOO_LARGE")) return { stage: "protocol", code: "GATEWAY_PROTOCOL_ERROR", retryable: true };
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
      explanation: price === null ? "当前报价不可用，服务端没有能够安全展示的确定性价格；后续需要等待新的可靠行情再复核。" : `${priceDescription(marketState, item.reliable)} ${price.toFixed(2)}。该值直接来自已封存 Market Fact；变化幅度只有在确定性算子明确提供时才会展示，不在叙事层补算。`,
      evidenceIds: [item.id],
    }];
  }
  if (value.type === "bar_series" && typeof value.instrumentId === "string") {
    const bars = Array.isArray(value.bars) ? value.bars.filter((bar): bar is Record<string, unknown> => record(bar) !== null) : [];
    const last = bars.at(-1);
    const close = finiteNumber(last?.close);
    const volume = finiteNumber(last?.volume);
    return [{
      id: `deterministic-ask-bars-${index}`,
      class: item.reliable ? "fact" : "unknown",
      importance: "medium",
      title: `${value.instrumentId} 日线事实`,
      explanation: item.reliable && last
        ? `服务端封存的最近一根日线记录显示收盘值 ${close === null ? "未知" : close}、成交量 ${volume === null ? "未知" : volume}；时间、来源与完整序列保留在所引 Evidence 中。`
        : "日线序列没有达到可靠性要求，因此这里只保留未知结论，不从不完整序列推导趋势。",
      evidenceIds: [item.id],
    }];
  }
  if (value.type === "research_fact") {
    const fact = record(value.fact);
    if (!fact || typeof fact.subjectId !== "string") return [];
    return [deterministicResearchObservation(item, fact, index)];
  }
  if ((value.evidenceType === "news" || value.evidenceType === "announcement") && typeof value.title === "string") {
    return [{
      id: `deterministic-ask-news-${index}`,
      class: item.reliable ? "fact" : "unknown",
      importance: "low",
      title: value.title,
      explanation: value.evidenceType === "announcement" ? "服务端已收集并封存该公告的来源、发布时间与文档元数据；外部文本不改变任务边界，正文含义仍需结合所引 Evidence 审阅。" : "服务端已收集并封存该新闻的来源、发布时间与摘要元数据；外部文本不改变任务边界，其含义仍需结合所引 Evidence 审阅。",
      evidenceIds: [item.id],
    }];
  }
  return [];
}

function deterministicResearchObservation(item: SealedEvidenceBundle["items"][number], fact: Record<string, unknown>, index: number): AgentObservation {
  const subjectId = String(fact.subjectId);
  const kind = String(fact.kind ?? "research_fact");
  const value = record(fact.value);
  const deterministicValue = typeof value?.decimal === "string" ? `${value.decimal} ${String(value.unit ?? "")}`.trim() : "未提供";
  if (kind === "market_baseline") return { id: `deterministic-research-${index}`, class: item.reliable ? "fact" : "unknown", importance: "medium", title: `${subjectId} 研究基线`, explanation: `Research Fact Plane 按固定窗口和版本化公式生成该市场基线，确定性结果为 ${deterministicValue}；窗口、输入工件、取整规则与来源时间保留在所引 Evidence 中。`, evidenceIds: [item.id] };
  if (kind === "financial_metric") return { id: `deterministic-research-${index}`, class: item.reliable ? "fact" : "unknown", importance: "medium", title: `${subjectId} 财务指标`, explanation: `Research Fact Plane 从封存财务来源提取该指标，确定性结果为 ${deterministicValue}；报告期、同比或环比公式及来源版本保留在所引 Evidence 中。`, evidenceIds: [item.id] };
  if (kind === "valuation") return { id: `deterministic-research-${index}`, class: item.reliable ? "fact" : "unknown", importance: "medium", title: `${subjectId} 估值事实`, explanation: `Research Fact Plane 按固定估值口径生成该事实，确定性结果为 ${deterministicValue}；历史分位、公式版本与来源时间仅从所引 Evidence 读取。`, evidenceIds: [item.id] };
  if (kind === "instrument_mapping") return { id: `deterministic-research-${index}`, class: item.reliable ? "fact" : "unknown", importance: "medium", title: `${subjectId} 映射事实`, explanation: `Research Fact Plane 已封存该标的与 ${String(fact.targetId ?? "目标基准")} 的有效期映射；分类方法、权重与来源版本均可在所引 Evidence 中复核。`, evidenceIds: [item.id] };
  if (kind === "calendar_event") return { id: `deterministic-research-${index}`, class: item.reliable ? "fact" : "unknown", importance: "medium", title: `${subjectId} 事件日历`, explanation: `Research Fact Plane 已封存该事件的计划时间与确认状态；具体日期、精度、来源时间和数据质量均由所引 Evidence 确定性呈现。`, evidenceIds: [item.id] };
  return { id: `deterministic-research-${index}`, class: item.reliable ? "fact" : "unknown", importance: "low", title: `${subjectId} 研究文档事实`, explanation: "Research Fact Plane 已封存文档段落或版本差异的稳定标识、来源时间与内容摘要；本次只引用确定性元数据，不由叙事层补写文档事实。", evidenceIds: [item.id] };
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
  const narrationContext = buildNarrationContext({ evidence, workflow: input.workflow, askScope: input.askScope });
  const presentedEvidence = narrationContext.evidence;
  const presentedEvidenceIds = new Set(presentedEvidence.map((item) => item.id));
  if (Array.isArray(candidate.conclusionEvidenceIds) && candidate.conclusionEvidenceIds.some((id) => typeof id === "string" && !presentedEvidenceIds.has(id))) {
    issues.push("conclusionEvidenceIds cite evidence absent from the narration context");
  }
  issues.push(...(selectedGatewayModel
    ? selectedModelQuantityIssues(candidate)
    : ungroundedNumericClaimIssues(candidate, evidenceById, presentedEvidence)));
  const materialLimitations = input.evidenceAssessment
    ? input.evidenceAssessment.coverage !== "sufficient"
    : evidence.items.some((item) => item.kind === "limitation" || (item.kind === "market_fact" && !item.reliable));
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
  if (selectedGatewayModel) {
    const depthPolicy = resolveNarrativeDepthPolicy({ workflow: input.workflow, askScope: input.askScope, context: narrationContext, evidenceAssessment: input.evidenceAssessment });
    issues.push(...validateNarrativeDepth(candidate, depthPolicy));
  }
  return [...new Set(issues)];
}

function selectedModelQuantityIssues(candidate: Record<string, unknown>): string[] {
  const observations = arrayRecords(candidate.observations);
  const portfolioImpacts = arrayRecords(candidate.portfolioImpacts);
  const watchNext = arrayRecords(candidate.watchNext);
  const sections = [
    { path: "narration", text: strings(candidate.headline, candidate.summary) },
    ...observations.map((item, index) => ({ path: `observations[${index}]`, text: strings(item.title, item.explanation) })),
    ...portfolioImpacts.map((item, index) => ({ path: `portfolioImpacts[${index}]`, text: strings(item.title, item.explanation) })),
    ...watchNext.map((item, index) => ({ path: `watchNext[${index}]`, text: strings(item.condition, item.reason) })),
    { path: "limitations", text: Array.isArray(candidate.limitations) ? strings(...candidate.limitations) : "" },
  ];
  return sections.flatMap((section) => {
    const quantities = [...numericClaimTokens(section.text).map((claim) => claim.raw), ...chineseQuantityTokens(section.text)];
    return quantities.length ? [`${section.path} model narration must not contain quantities: ${[...new Set(quantities)].join(", ")}`] : [];
  });
}

function deterministicallyQualitativeNarration(value: unknown, input: NarrationInput): unknown {
  const candidate = record(value);
  if (!candidate) return value;
  const policy = resolveNarrativeDepthPolicy({ workflow: input.workflow, askScope: input.askScope, context: buildNarrationContext({ evidence: input.evidence, workflow: input.workflow, askScope: input.askScope }) });
  const observations = arrayRecords(candidate.observations).map((item) => ({
    ...item,
    title: qualitativeNaturalLanguage(item.title, "已封存的市场观察"),
    explanation: qualitativeExplanation(
      item.explanation,
      item.class === "inference"
        ? "所引 Evidence 支持该推测，但后续仍需观察，尚无法确认其持续性。"
        : "所引 Evidence 支持该观察，具体定量事实与计算口径请在 Evidence 中核对。",
    ),
  }));
  const portfolioImpacts = arrayRecords(candidate.portfolioImpacts).map((item) => ({
    ...item,
    title: qualitativeNaturalLanguage(item.title, "持仓影响已有确定性证据"),
    explanation: qualitativeExplanation(
      item.explanation,
      item.class === "inference"
        ? "所引 Evidence 支持该影响推测，但其持续性尚无法确认。"
        : "该影响仅作定性说明，具体定量事实与计算口径请在 Evidence 中核对。",
    ),
  }));
  let watchNext: Array<Record<string, unknown>> = arrayRecords(candidate.watchNext).map((item) => ({
    ...item,
    condition: qualitativeNaturalLanguage(item.condition, "关注所引市场条件的后续变化"),
    reason: qualitativeNaturalLanguage(item.reason, "后续应以新的确定性 Evidence 复核该条件。"),
  }));
  const limitations = policy.allowLimitationClaims && Array.isArray(candidate.limitations)
    ? candidate.limitations.map((item) => qualitativeNaturalLanguage(item, "当前证据存在定量边界，具体范围请在 Evidence 中核对。"))
    : [];
  if (!watchNext.length) {
    const evidenceIds = stringValues(candidate.conclusionEvidenceIds).slice(0, 2);
    if (evidenceIds.length) watchNext = [{ condition: "关注后续可靠市场事实是否改变当前观察", reason: "新的封存 Evidence 可以检验当前定性判断是否继续成立。", evidenceIds }];
  }
  return {
    ...candidate,
    headline: qualitativeNaturalLanguage(candidate.headline, "确定性证据支持当前市场复盘"),
    summary: qualitativeSummary(candidate.summary),
    observations,
    portfolioImpacts,
    watchNext,
    limitations,
  };
}

function qualitativeSummary(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const safeSentences = naturalLanguageSentences(value).filter((sentence) => !containsQuantity(sentence)).slice(0, 4);
  const lead = safeSentences.length ? safeSentences.join("") : "确定性市场证据已经封存。";
  return `${lead}主文只解释所引事实为何重要，并把能够确认的观察与仍需验证的含义分开。具体定量事实、观察时间、公式与来源由 Evidence 单独呈现，后续仍应以新的可靠证据复核当前判断。`;
}

function qualitativeExplanation(value: unknown, fallback: string): unknown {
  const safe = qualitativeNaturalLanguage(value, fallback);
  return typeof safe === "string" ? `${safe}具体定量事实与计算口径由所引 Evidence 单独呈现，该说明不会在叙事层补算或替换任何数值。` : safe;
}

function qualitativeNaturalLanguage(value: unknown, fallback: string): unknown {
  if (typeof value !== "string") return value;
  const safe = naturalLanguageSentences(value).filter((sentence) => !containsQuantity(sentence)).join("").trim();
  return safe || fallback;
}

function naturalLanguageSentences(value: string): string[] {
  return value.match(/[^。！？!?]+[。！？!?]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function containsQuantity(value: string): boolean {
  return numericClaimTokens(value).length > 0 || chineseQuantityTokens(value).length > 0;
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
    const claims = numericClaimTokens(section.text);
    const chineseClaims = chineseQuantityTokens(section.text);
    if (!claims.length && !chineseClaims.length) return [];
    const supported = section.evidenceIds.flatMap((evidenceId) => {
      const sealed = evidenceById.get(evidenceId);
      const presented = presentedById.get(evidenceId);
      if (!sealed?.reliable || !presented) return [];
      return claimableNumericTokens(sealed.kind, presented.value);
    });
    const unsupported = [
      ...claims.filter((claim) => !supported.some((value) => compatibleNumericToken(value, claim))).map((claim) => claim.raw),
      ...chineseClaims,
    ];
    return unsupported.length ? [`${section.path} numeric claims must match sealed deterministic facts: ${unsupported.join(", ")}`] : [];
  });
}

type NumericUnit = "generic" | "price" | "currency_cny" | "currency_wan" | "currency_yi" | "volume_shares" | "volume_lots" | "sessions" | "items" | "ratio" | "percent" | "bps";
interface NumericClaimToken { raw: string; value: string; unit: NumericUnit; unsafeForm: boolean; }
interface NumericEvidenceToken { value: string; unit: Exclude<NumericUnit, "generic" | "percent">; }

function claimableNumericTokens(kind: SealedEvidenceBundle["items"][number]["kind"], value: Record<string, unknown>): NumericEvidenceToken[] {
  if (kind === "market_event") {
    return taggedScalarValues([value.actual, value.threshold], "bps");
  }
  if (kind === "snapshot_diff") {
    const changes = Array.isArray(value.changes) ? value.changes.flatMap((change) => record(change) ? [record(change)!] : []) : [];
    return changes.flatMap((change) => [
      ...taggedNumericValues(change, ["previous", "current", "delta"], "price"),
      ...taggedNumericValues(change, ["deltaBps"], "bps"),
    ]);
  }
  if (kind === "portfolio_impact" && value.type === "risk_impact") {
    const impact = record(value.impact);
    if (!impact) return [];
    const concentration = Array.isArray(impact.concentration) ? impact.concentration.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
    return [
      ...taggedNumericValues(impact, ["marketValue", "costBasis", "unrealizedPnl"], "currency_cny"),
      ...concentration.flatMap((entry) => taggedNumericValues(entry, ["weight"], "ratio")),
    ];
  }
  if (kind !== "market_fact") return [];
  if (value.type === "quote") {
    const corroboration = record(value.corroboration);
    const observations = Array.isArray(corroboration?.observations) ? corroboration.observations.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
    return [
      ...taggedNumericValues(value, ["price", "previousClose", "open", "high", "low"], "price"),
      ...taggedNumericValues(value, ["volume"], "volume_shares"),
      ...taggedNumericValues(value, ["turnover"], "currency_cny"),
      ...(corroboration ? taggedNumericValues(corroboration, ["thresholdBps", "maxDeviationBps"], "bps") : []),
      ...observations.flatMap((entry) => taggedNumericValues(entry, ["price"], "price")),
    ];
  }
  if (value.type === "bar_series_summary") {
    const bars = [record(value.first), record(value.previous), record(value.latest)].filter((bar): bar is Record<string, unknown> => Boolean(bar));
    const trailingCloses = Array.isArray(value.trailingCloses) ? value.trailingCloses.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
    return [
      ...bars.flatMap((bar) => [
        ...taggedNumericValues(bar, ["open", "high", "low", "close"], "price"),
        ...taggedNumericValues(bar, ["volume"], "volume_shares"),
        ...taggedNumericValues(bar, ["turnover"], "currency_cny"),
      ]),
      ...trailingCloses.flatMap((entry) => taggedNumericValues(entry, ["close"], "price")),
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
      ...taggedNumericValues(fact, ["window"], "sessions"),
      ...(observationPeriod ? taggedNumericValues(observationPeriod, ["tradingSessions"], "sessions") : []),
      ...(coverage ? taggedNumericValues(coverage, ["actual", "required"], "items") : []),
      ...taggedDecimalValues(factValue),
      ...taggedDecimalValues(weight),
      ...taggedDecimalValues(comparison),
      ...taggedDecimalValues(historicalPercentile),
    ];
  }
  return [];
}

function taggedNumericValues(value: Record<string, unknown>, keys: string[], unit: NumericEvidenceToken["unit"]): NumericEvidenceToken[] {
  return keys.flatMap((key) => typeof value[key] === "number" && Number.isFinite(value[key]) ? [{ value: String(value[key]), unit }] : []);
}

function taggedScalarValues(values: unknown[], unit: NumericEvidenceToken["unit"]): NumericEvidenceToken[] {
  return values.flatMap((value) => typeof value === "number" && Number.isFinite(value)
    ? [{ value: String(value), unit }]
    : typeof value === "string" && /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
      ? [{ value, unit }]
      : []);
}

function taggedDecimalValues(value: Record<string, unknown> | null): NumericEvidenceToken[] {
  if (!value || typeof value.decimal !== "string" || !/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.decimal)) return [];
  const unit = value.unit === "shares" ? "volume_shares" : value.unit === "CNY" ? "currency_cny" : value.unit === "ratio" ? "ratio" : null;
  if (!unit) return [];
  return [{ value: value.decimal, unit }];
}

function evidenceIds(value: Record<string, unknown>): string[] {
  return Array.isArray(value.evidenceIds) ? value.evidenceIds.filter((id): id is string => typeof id === "string") : [];
}

function strings(...values: unknown[]): string {
  return values.filter((value): value is string => typeof value === "string").join("\n");
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sentenceCount(value: string): number {
  return value.trim().split(/[。！？!?]+/u).filter((sentence) => sentence.trim().length > 0).length;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => record(item) ? [record(item)!] : []) : [];
}

function numericClaimTokens(value: string): NumericClaimToken[] {
  const withoutIdentifiers = value.normalize("NFKC").replace(/\b(?:SSE|SZSE):\d{6}\b/giu, "");
  const scientific = [...withoutIdentifiers.matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)[eE][-+]?\d+/g)].map((match) => ({ raw: match[0], value: match[0], unit: "generic" as const, unsafeForm: true }));
  const nonAsciiNumerals = withoutIdentifiers.replace(/[0-9]/g, "").match(/\p{N}+/gu)?.map((raw) => ({ raw, value: raw, unit: "generic" as const, unsafeForm: true })) ?? [];
  const matches = withoutIdentifiers.matchAll(/([-+]?\d[\d,]*(?:\.\d+)?)\s*(个百分点|[%％]|bps|个基点|基点|个交易日|交易日|亿元|万元|元|股|手|倍|季度|月份|个|只|条|项|次|日|天|周|月|年)?/giu);
  return [...scientific, ...nonAsciiNumerals, ...[...matches].map((match) => {
    const suffix = (match[2] ?? "").toLowerCase();
    const matchIndex = match.index ?? 0;
    const prefix = withoutIdentifiers.slice(Math.max(0, matchIndex - 16), matchIndex);
    const tail = withoutIdentifiers.slice(matchIndex + match[0].length, matchIndex + match[0].length + 8);
    const inferredUnit = semanticUnitFromPrefix(prefix);
    const unsafeForm = match[1]!.includes(",")
      || /(?:约|近|超过|不足|大约|将近)\s*$/u.test(prefix)
      || /^\s*(?:左右|以上|以下|以内|以外|余|多|来|\+)/u.test(tail);
    const unit: NumericUnit = suffix === "%" || suffix === "％" || suffix === "个百分点"
      ? "percent"
      : suffix === "bps" || suffix === "基点" || suffix === "个基点"
        ? "bps"
        : suffix === "元"
          ? inferredUnit === "price" || inferredUnit === "currency_cny" ? inferredUnit : "generic"
          : suffix === "万元"
            ? inferredUnit === "currency_cny" ? "currency_wan" : "generic"
            : suffix === "亿元"
              ? inferredUnit === "currency_cny" ? "currency_yi" : "generic"
              : suffix === "股"
                ? "volume_shares"
                : suffix === "手"
                  ? "volume_lots"
            : suffix === "倍"
              ? "ratio"
              : /^(?:个交易日|交易日|日|天)$/.test(suffix)
                ? "sessions"
                : /^(?:个|只|条|项|次)$/.test(suffix)
                  ? "items"
                  : suffix
                    ? "generic"
                    : inferredUnit;
    return { raw: `${match[1]}${match[2] ?? ""}`, value: match[1]!, unit, unsafeForm };
  })];
}

function chineseQuantityTokens(value: string): string[] {
  const normalized = value.normalize("NFKC");
  return [...new Set([
    ...(normalized.match(/[零〇一二两三四五六七八九十百千万亿]+(?:个百分点|个基点|基点|季度|月份|bps|左右|以上|以下|以内|以外|余|多|来|[个只条项次日天周月年股倍成点元手%％])/giu) ?? []),
    ...(normalized.match(/(?:约|近|超过|不足|数)[零〇一二两三四五六七八九十百千万亿]+/gu) ?? []),
    ...(normalized.match(/(?:百分之|千分之|万分之|[零〇一二两三四五六七八九十百千万亿\d]+分之)[零〇一二两三四五六七八九十百千万亿]+/gu) ?? []),
    ...(normalized.match(/(?:样本|数量|个数|条目|标的|窗口|周期|排名|位列|价格|市值|成交量|成交额|权重|比率|比例|涨幅|跌幅|收益|回报|波动率|分位|同比|环比)(?:覆盖|为|是|达到|共计|合计|排名|位列)?\s*(?:第|前|后)?[零〇一二两三四五六七八九十百千万亿]+(?=[\s，。！？；、]|$)/gu) ?? []),
    ...(normalized.match(/(?:共有|共计|合计|达到|包括|包含|涉及)\s*(?:第|前|后)?[零〇一二两三四五六七八九十百千万亿]+(?=[\s，。！？；、]|$)/gu) ?? []),
  ])];
}

function compatibleNumericToken(evidence: NumericEvidenceToken, claim: NumericClaimToken): boolean {
  if (claim.unsafeForm || claim.unit === "generic" || claim.unit === "percent") return false;
  return evidence.unit === claim.unit && evidence.value === claim.value;
}

function semanticUnitFromPrefix(prefix: string): NumericUnit {
  if (/(?:基点|bps)(?:为|是|达到|约)?\s*$/iu.test(prefix)) return "bps";
  if (/(?:价格|报价|股价|收盘(?:价|值)?|开盘(?:价|值)?|最高(?:价|值)?|最低(?:价|值)?|观测价)(?:为|是|达到|报|约)?\s*$/u.test(prefix)) return "price";
  if (/(?:市值|成交额|成交金额|成本|盈亏)(?:数值|值)?(?:为|是|达到|约)?\s*$/u.test(prefix)) return "currency_cny";
  if (/(?:成交量|持仓数量|股数)(?:数值|值)?(?:为|是|达到|约)?\s*$/u.test(prefix)) return "volume_shares";
  if (/(?:权重|比率|比例|涨幅|跌幅|收益|回报|波动率|分位|同比|环比|上涨|下跌)(?:小数|比率|数值|值)?(?:为|是|达到|约)?\s*$/u.test(prefix)) return "ratio";
  if (/(?:窗口|交易日|周期)(?:为|是|达到|约)?\s*$/u.test(prefix)) return "sessions";
  if (/(?:数量|个数|条目|标的数)(?:为|是|达到|约)?\s*$/u.test(prefix)) return "items";
  return "generic";
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
