import { calculateCash } from "./ledger";
import { blockingStaleQuotes } from "./market-clock";
import type { EvidenceItem, EvidencePack, PortfolioHistoryPoint, Position, Quote, ReconciliationResult, RiskEvent, RiskMetric, RiskRules, TradePlan, Transaction } from "./types";

export interface RiskEngineInput { transactions: Transaction[]; positions: Position[]; quotes: Quote[]; tradePlans: TradePlan[]; riskRules: RiskRules; portfolioHistory: PortfolioHistoryPoint[]; reconciliation: ReconciliationResult; now?: string }
export interface RiskEngineResult { positions: Position[]; metrics: RiskMetric[]; events: RiskEvent[]; evidencePack: EvidencePack; warnings: string[]; portfolio: { netValue: number; marketValue: number; cash: number; nominalExposure: number; effectiveExposure: number; dayPnl: number; reliable: boolean } }

export function calculateRisk(input: RiskEngineInput): RiskEngineResult {
  const now = input.now ?? new Date().toISOString();
  const quoteById = new Map(input.quotes.map((item) => [item.instrumentId, item]));
  const planById = new Map(input.tradePlans.map((item) => [item.instrumentId, item]));
  const cash = calculateCash(input.transactions);
  const valued = input.positions.map((position) => {
    const quote = quoteById.get(position.instrumentId);
    const marketValue = quote?.price == null ? null : quote.price * position.quantity;
    const dayPnl = quote?.price == null || quote.previousClose == null ? null : (quote.price - quote.previousClose) * position.quantity;
    const plan = planById.get(position.instrumentId);
    return { ...position, price: quote?.price ?? null, marketValue, unrealizedPnl: marketValue == null ? null : marketValue - position.costBasis, dayPnl, quoteQuality: quote?.quality ?? "unavailable", quoteTime: quote?.marketTimestamp?.slice(11, 19) ?? "—", planStatus: plan ? "aligned" as const : "missing" as const };
  });
  const marketValue = valued.reduce((sum, item) => sum + (item.marketValue ?? 0), 0);
  const netValue = cash + marketValue;
  const missingQuotes = valued.filter((item) => item.marketValue == null);
  const staleQuotes = blockingStaleQuotes(input.quotes, now);
  const warnings = [
    ...missingQuotes.map((item) => `${item.instrumentId} 缺少可用报价`),
    ...staleQuotes.map((item) => `${item.instrumentId} 行情过期`),
    ...(input.reconciliation.unresolved ? ["持仓尚未完成对账"] : []),
    ...input.reconciliation.anomalies.map((item) => item.message),
  ];
  const reliable = warnings.length === 0;
  const positions = valued.map((item) => {
    const nominalWeight = item.marketValue == null || netValue <= 0 ? null : item.marketValue / netValue;
    const effectiveExposure = nominalWeight == null ? null : nominalWeight * item.leverageMultiplier;
    const plan = planById.get(item.instrumentId);
    return { ...item, nominalWeight, effectiveExposure, planStatus: !plan ? "missing" as const : nominalWeight != null && nominalWeight > plan.maxWeight ? "overweight" as const : "aligned" as const };
  });
  const nominalExposure = positions.reduce((sum, item) => sum + (item.nominalWeight ?? 0), 0);
  const effectiveExposure = positions.reduce((sum, item) => sum + (item.effectiveExposure ?? 0), 0);
  const dayPnl = positions.reduce((sum, item) => sum + (item.dayPnl ?? 0), 0);
  const dataTimes = input.quotes.map((quote) => quote.marketTimestamp).filter((value): value is string => Boolean(value));
  const quoteEvidence = (id: string) => { const quote = quoteById.get(id); return quote ? `quote:${id}:${quote.marketTimestamp ?? quote.receivedAt}` : `quote:${id}:missing`; };
  const metrics: RiskMetric[] = [];
  const events: RiskEvent[] = [];
  for (const position of positions) {
    const evidenceIds = [...position.transactionEvidenceIds, quoteEvidence(position.instrumentId), "risk-rule:max-single-position"];
    metrics.push({ id: `metric:single:${position.instrumentId}`, label: `${position.name} 单标的仓位`, value: position.nominalWeight, reliable, evidenceIds, calculation: { inputs: { marketValue: position.marketValue, netValue }, formula: "marketValue / netValue", intermediate: { marketValue: position.marketValue }, finalResult: position.nominalWeight, dataSources: ["local-ledger", quoteById.get(position.instrumentId)?.source ?? "missing"], dataTimes } });
    if (position.nominalWeight != null && position.nominalWeight > input.riskRules.maxSinglePosition) events.push(event(`single:${position.instrumentId}`, "position.max_weight", "单标的仓位超过阈值", `${position.name} 仓位 ${(position.nominalWeight * 100).toFixed(1)}%，超过 ${(input.riskRules.maxSinglePosition * 100).toFixed(0)}%。`, position.nominalWeight, input.riskRules.maxSinglePosition, now, evidenceIds, warnings));
    const plan = planById.get(position.instrumentId);
    if (plan && position.nominalWeight != null && position.nominalWeight > plan.maxWeight) events.push(event(`plan:${position.instrumentId}`, "plan.max_position", "计划仓位超限", `${position.name} 超过计划上限 ${(plan.maxWeight * 100).toFixed(0)}%。`, position.nominalWeight, plan.maxWeight, now, [...position.transactionEvidenceIds, plan.evidenceId], warnings, "medium"));
  }
  const themeValues = new Map<string, number>();
  positions.forEach((position) => position.themes.forEach((theme) => themeValues.set(theme, (themeValues.get(theme) ?? 0) + (position.effectiveExposure ?? 0))));
  for (const [theme, exposure] of themeValues) {
    const related = positions.filter((position) => position.themes.includes(theme));
    const evidenceIds = [...new Set(related.flatMap((position) => [...position.transactionEvidenceIds, quoteEvidence(position.instrumentId)])), "risk-rule:max-theme"];
    metrics.push({ id: `metric:theme:${theme}`, label: `${theme} 主题集中度`, value: exposure, reliable, evidenceIds, calculation: { inputs: Object.fromEntries(related.map((item) => [item.instrumentId, item.effectiveExposure])), formula: "sum(positionMarketValue × leverageMultiplier) / netValue", intermediate: { relatedPositions: related.length }, finalResult: exposure, dataSources: ["local-ledger", ...related.map((item) => quoteById.get(item.instrumentId)?.source ?? "missing")], dataTimes } });
    if (exposure > input.riskRules.maxThemeConcentration) events.push(event(`theme:${theme}`, "portfolio.max_theme_concentration", "主题集中度超过阈值", `${theme} 有效集中度 ${(exposure * 100).toFixed(1)}%，超过 ${(input.riskRules.maxThemeConcentration * 100).toFixed(0)}%。`, exposure, input.riskRules.maxThemeConcentration, now, evidenceIds, warnings));
  }
  const exposureEvidence = [...new Set(positions.flatMap((item) => [...item.transactionEvidenceIds, quoteEvidence(item.instrumentId)])), "risk-rule:max-effective-exposure"];
  metrics.push({ id: "metric:effective-exposure", label: "有效总敞口", value: effectiveExposure, reliable, evidenceIds: exposureEvidence, calculation: { inputs: { netValue, positionCount: positions.length }, formula: "sum(positionMarketValue × leverageMultiplier) / netValue", intermediate: { nominalExposure, effectiveExposure }, finalResult: effectiveExposure, dataSources: ["local-ledger", ...input.quotes.map((item) => item.source)], dataTimes } });
  if (effectiveExposure > input.riskRules.maxEffectiveExposure) events.push(event("effective-exposure", "portfolio.max_effective_exposure", "有效总敞口超过限制", `有效敞口 ${(effectiveExposure * 100).toFixed(1)}%，超过 ${(input.riskRules.maxEffectiveExposure * 100).toFixed(0)}%；${reliable ? "结果可靠" : "因数据质量问题仅供警示"}。`, effectiveExposure, input.riskRules.maxEffectiveExposure, now, exposureEvidence, warnings));
  for (const quote of staleQuotes) events.push(event(`stale:${quote.instrumentId}`, "data_quality.quote_stale", "盘中行情过期，风险不可可靠计算", `${quote.instrumentId} 盘中报价超过 ${(input.riskRules.quoteStaleSeconds / 60).toFixed(0)} 分钟未更新，相关结果已降低可信度。`, null, input.riskRules.quoteStaleSeconds, now, [quoteEvidence(quote.instrumentId)], quote.warnings, "medium"));
  if (input.reconciliation.unresolved) events.push(event("reconciliation", "data_quality.position_unreconciled", "持仓未对账", "交易推导持仓与券商数量尚未确认一致。", null, null, now, input.reconciliation.items.map((item) => `reconciliation:${item.instrumentId}`), warnings, "medium"));
  const evidence = createEvidence(input, positions, metrics, events, now);
  const evidencePack: EvidencePack = { id: `evidence-pack:${now}`, generatedAt: now, reliable, evidence, metrics, events, warnings };
  return { positions: positions.map((position) => ({ ...position, riskEventIds: events.filter((risk) => risk.evidenceIds.some((id) => position.transactionEvidenceIds.includes(id))).map((risk) => risk.id) })), metrics, events, evidencePack, warnings, portfolio: { netValue, marketValue, cash, nominalExposure, effectiveExposure, dayPnl, reliable } };
}

function event(id: string, ruleId: string, title: string, message: string, actualValue: number | null, threshold: number | null, triggeredAt: string, evidenceIds: string[], dataWarnings: string[], severity: RiskEvent["severity"] = "high"): RiskEvent { return { id: `risk:${id}`, ruleId, severity, status: "active", title, message, actualValue, threshold, triggeredAt, evidenceIds, dataWarnings }; }

function createEvidence(input: RiskEngineInput, positions: Position[], metrics: RiskMetric[], events: RiskEvent[], now: string): EvidenceItem[] {
  const transactions: EvidenceItem[] = input.transactions.map((item) => ({ id: `transaction:${item.id}`, type: "交易事件", title: `${item.type} ${item.instrumentId ?? item.account}`, timestamp: item.executedAt, source: "local-portfolio-repository", payload: { account: item.account, instrumentId: item.instrumentId, type: item.type, side: item.side, quantity: item.quantity, price: item.price, fee: item.fee, fingerprint: item.fingerprint } }));
  const quoteIds = new Set(input.quotes.map((item) => item.instrumentId));
  const quotes: EvidenceItem[] = [
    ...input.quotes.map((item) => ({ id: `quote:${item.instrumentId}:${item.marketTimestamp ?? item.receivedAt}`, type: "行情", title: `${item.instrumentId} 报价`, timestamp: item.marketTimestamp ?? item.receivedAt, source: item.source, payload: { price: item.price, previousClose: item.previousClose, quality: item.quality, stale: item.stale, receivedAt: item.receivedAt } })),
    ...positions.filter((item) => !quoteIds.has(item.instrumentId)).map((item) => ({ id: `quote:${item.instrumentId}:missing`, type: "行情缺失", title: `${item.instrumentId} 无可用报价`, timestamp: now, source: "market-provider", payload: { price: null, quality: "unavailable", stale: true } } as EvidenceItem)),
  ];
  const reconciliation: EvidenceItem[] = input.reconciliation.items.map((item) => ({ id: `reconciliation:${item.instrumentId}`, type: "对账", title: `${item.name} 数量对账`, timestamp: now, source: "risk-engine", payload: { derivedQuantity: item.derivedQuantity, brokerQuantity: item.brokerQuantity, quantityDifference: item.quantityDifference, derivedAverageCost: item.derivedAverageCost, brokerAverageCost: item.brokerAverageCost, status: item.status } }));
  const calculated: EvidenceItem[] = metrics.map((item) => ({ id: item.id, type: "风险计算", title: item.label, timestamp: now, source: "risk-engine", payload: { value: item.value, reliable: item.reliable, formula: item.calculation.formula } }));
  const rules: EvidenceItem[] = [
    { id: "risk-rule:max-single-position", type: "风险规则", title: "单标的上限", timestamp: now, source: "risk-rules", payload: { threshold: input.riskRules.maxSinglePosition } },
    { id: "risk-rule:max-theme", type: "风险规则", title: "主题集中度上限", timestamp: now, source: "risk-rules", payload: { threshold: input.riskRules.maxThemeConcentration } },
    { id: "risk-rule:max-effective-exposure", type: "风险规则", title: "有效敞口上限", timestamp: now, source: "risk-rules", payload: { threshold: input.riskRules.maxEffectiveExposure } },
    ...input.tradePlans.map((plan) => ({ id: plan.evidenceId, type: "交易计划", title: `${plan.instrumentId} 仓位计划`, timestamp: now, source: "local-plan", payload: { maxWeight: plan.maxWeight } })),
  ];
  return [...transactions, ...quotes, ...reconciliation, ...calculated, ...rules, ...events.map((item) => ({ id: item.id, type: "风险事件", title: item.title, timestamp: item.triggeredAt, source: "risk-engine", payload: { actualValue: item.actualValue, threshold: item.threshold, reliable: item.dataWarnings.length === 0 } } as EvidenceItem))];
}
