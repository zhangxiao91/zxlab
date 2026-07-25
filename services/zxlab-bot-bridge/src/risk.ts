import type { MarketQuote } from "./market.js";

export interface RiskPositionInput {
  instrumentId: string;
  quantity: number;
  averageCost?: number;
  leverageMultiplier?: number;
  themes?: string[];
}

export interface PortfolioHistoryInput {
  date: string;
  value: number;
}

export interface RiskRulesInput {
  maxSinglePosition: number;
  maxThemeConcentration: number;
  maxEffectiveExposure: number;
  maxDrawdown: number;
}

export interface RiskSnapshot {
  asOf: string;
  reliable: boolean;
  portfolio: {
    cash: number;
    marketValue: number;
    netValue: number;
    nominalExposure: number;
    effectiveExposure: number;
    currentDrawdown: number | null;
    maxDrawdown: number | null;
  };
  positions: Array<{
    instrumentId: string;
    quantity: number;
    averageCost: number | null;
    price: number | null;
    marketValue: number | null;
    nominalWeight: number | null;
    effectiveExposure: number | null;
    leverageMultiplier: number;
    themes: string[];
    quoteQuality: string;
    quoteTimestamp: string | null;
    reliable: boolean;
    evidenceIds: string[];
  }>;
  themeConcentration: Array<{ theme: string; effectiveExposure: number; reliable: boolean }>;
  events: Array<{
    id: string;
    severity: "critical" | "high" | "medium";
    title: string;
    explanation: string;
    evidenceIds: string[];
  }>;
  warnings: string[];
  limitations: string[];
}

export interface RiskReview {
  summary: string;
  mainRisks: Array<{
    title: string;
    explanation: string;
    severity: "critical" | "high" | "medium" | "low";
    evidenceIds: string[];
  }>;
  unknowns: string[];
  limitations: string[];
}

const DEFAULT_RULES: RiskRulesInput = {
  maxSinglePosition: 0.35,
  maxThemeConcentration: 0.5,
  maxEffectiveExposure: 1.2,
  maxDrawdown: 0.1,
};

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function drawdowns(history: PortfolioHistoryInput[], currentValue: number): { current: number | null; max: number | null } {
  if (!history.length || currentValue <= 0) return { current: null, max: null };
  const values = [...history.map((item) => item.value), currentValue].filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return { current: null, max: null };
  let peak = values[0]!;
  let max = 0;
  let current = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    current = value / peak - 1;
    max = Math.min(max, current);
  }
  return { current: round(current), max: round(max) };
}

export function calculateRiskSnapshot(input: {
  positions: RiskPositionInput[];
  quotes: MarketQuote[];
  cash: number;
  history?: PortfolioHistoryInput[];
  rules?: Partial<RiskRulesInput>;
  now?: string;
}): RiskSnapshot {
  const rules = { ...DEFAULT_RULES, ...input.rules };
  const quoteById = new Map(input.quotes.map((quote) => [quote.instrumentId, quote]));
  const warnings: string[] = [];
  const limitations: string[] = [];
  const valued = input.positions.map((position) => {
    const quote = quoteById.get(position.instrumentId);
    const leverage = position.leverageMultiplier ?? 1;
    if (position.leverageMultiplier === undefined) warnings.push(`${position.instrumentId} 未提供杠杆倍数，暂按 1 倍计算。`);
    if (!position.themes?.length) limitations.push(`${position.instrumentId} 未提供主题标签，主题集中度可能低估。`);
    if (!quote || quote.price === null) warnings.push(`${position.instrumentId} 缺少可用报价。`);
    else if (quote.stale || quote.quality === "stale" || quote.quality === "unavailable") {
      warnings.push(`${position.instrumentId} 行情不新鲜：${quote.warnings.join("；") || quote.quality}。`);
    }
    const price = quote?.price ?? null;
    return {
      input: position,
      quote,
      leverage,
      marketValue: price === null ? null : position.quantity * price,
      reliable: Boolean(quote && price !== null && !quote.stale && ["live", "cached"].includes(quote.quality)),
    };
  });
  const marketValue = valued.reduce((sum, item) => sum + (item.marketValue ?? 0), 0);
  const netValue = input.cash + marketValue;
  const positions = valued.map((item) => {
    const nominalWeight = item.marketValue === null || netValue <= 0 ? null : item.marketValue / netValue;
    const quoteTime = item.quote?.marketTimestamp ?? null;
    return {
      instrumentId: item.input.instrumentId,
      quantity: item.input.quantity,
      averageCost: item.input.averageCost ?? null,
      price: item.quote?.price ?? null,
      marketValue: item.marketValue === null ? null : round(item.marketValue),
      nominalWeight: nominalWeight === null ? null : round(nominalWeight),
      effectiveExposure: nominalWeight === null ? null : round(nominalWeight * item.leverage),
      leverageMultiplier: item.leverage,
      themes: item.input.themes ?? [],
      quoteQuality: item.quote?.quality ?? "unavailable",
      quoteTimestamp: quoteTime,
      reliable: item.reliable,
      evidenceIds: [`position:${item.input.instrumentId}`, `quote:${item.input.instrumentId}:${quoteTime ?? "missing"}`],
    };
  });
  const nominalExposure = positions.reduce((sum, item) => sum + (item.nominalWeight ?? 0), 0);
  const effectiveExposure = positions.reduce((sum, item) => sum + (item.effectiveExposure ?? 0), 0);
  const themes = new Map<string, number>();
  for (const position of positions) {
    for (const theme of position.themes) themes.set(theme, (themes.get(theme) ?? 0) + (position.effectiveExposure ?? 0));
  }
  const reliable = positions.every((position) => position.reliable) && positions.length > 0;
  const dd = drawdowns(input.history ?? [], netValue);
  if (!input.history?.length) limitations.push("未提供组合历史净值，当前回撤和历史最大回撤不可计算。");
  const events: RiskSnapshot["events"] = [];
  for (const position of positions) {
    if (!position.reliable) {
      events.push({
        id: `risk:data-unreliable:${position.instrumentId}`,
        severity: "high",
        title: `${position.instrumentId} 风险结果不可靠`,
        explanation: "该仓位缺少新鲜报价；市值、权重和敞口只能作为提示，不能作为可靠决策依据。",
        evidenceIds: position.evidenceIds,
      });
    }
    if (position.nominalWeight !== null && position.nominalWeight > rules.maxSinglePosition) {
      events.push({
        id: `risk:position-concentration:${position.instrumentId}`,
        severity: "high",
        title: `${position.instrumentId} 单仓集中度偏高`,
        explanation: `名义权重 ${(position.nominalWeight * 100).toFixed(1)}%，高于规则 ${(rules.maxSinglePosition * 100).toFixed(0)}%。`,
        evidenceIds: position.evidenceIds,
      });
    }
  }
  const themeConcentration = [...themes.entries()].map(([theme, value]) => ({
    theme,
    effectiveExposure: round(value),
    reliable,
  }));
  for (const item of themeConcentration) {
    if (item.effectiveExposure > rules.maxThemeConcentration) {
      events.push({
        id: `risk:theme-concentration:${item.theme}`,
        severity: "high",
        title: `${item.theme} 主题集中度偏高`,
        explanation: `有效主题敞口 ${(item.effectiveExposure * 100).toFixed(1)}%，高于规则 ${(rules.maxThemeConcentration * 100).toFixed(0)}%。`,
        evidenceIds: positions.filter((position) => position.themes.includes(item.theme)).flatMap((position) => position.evidenceIds),
      });
    }
  }
  if (effectiveExposure > rules.maxEffectiveExposure) {
    events.push({
      id: "risk:effective-exposure",
      severity: reliable ? "critical" : "high",
      title: "有效总敞口超过限制",
      explanation: `当前${reliable ? "" : "提示性"}有效敞口 ${(effectiveExposure * 100).toFixed(1)}%，高于规则 ${(rules.maxEffectiveExposure * 100).toFixed(0)}%。`,
      evidenceIds: positions.flatMap((position) => position.evidenceIds),
    });
  }
  if (dd.current !== null && dd.current < -rules.maxDrawdown) {
    events.push({
      id: "risk:drawdown",
      severity: "high",
      title: "当前回撤超过限制",
      explanation: `当前回撤 ${(dd.current * 100).toFixed(1)}%，超过规则 ${(rules.maxDrawdown * 100).toFixed(0)}%。`,
      evidenceIds: ["portfolio-history"],
    });
  }
  return {
    asOf: input.now ?? new Date().toISOString(),
    reliable,
    portfolio: {
      cash: round(input.cash),
      marketValue: round(marketValue),
      netValue: round(netValue),
      nominalExposure: round(nominalExposure),
      effectiveExposure: round(effectiveExposure),
      currentDrawdown: dd.current,
      maxDrawdown: dd.max,
    },
    positions,
    themeConcentration,
    events,
    warnings: [...new Set(warnings)],
    limitations: [...new Set(limitations)],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRiskReview(value: unknown, allowedEvidenceIds: Set<string>): RiskReview {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.mainRisks) ||
    !Array.isArray(value.unknowns) || !Array.isArray(value.limitations)) {
    throw new Error("ZXLab AI Gateway returned an invalid Risk review.");
  }
  const mainRisks = value.mainRisks.map((item) => {
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.explanation !== "string" ||
      !["critical", "high", "medium", "low"].includes(String(item.severity)) || !Array.isArray(item.evidenceIds)) {
      throw new Error("ZXLab AI Gateway returned an invalid Risk item.");
    }
    const evidenceIds = item.evidenceIds.filter((id): id is string => typeof id === "string");
    if (!evidenceIds.length || evidenceIds.some((id) => !allowedEvidenceIds.has(id))) {
      throw new Error("ZXLab AI Gateway Risk review cited unknown evidence.");
    }
    return {
      title: item.title,
      explanation: item.explanation,
      severity: item.severity as RiskReview["mainRisks"][number]["severity"],
      evidenceIds,
    };
  });
  return {
    summary: value.summary,
    mainRisks,
    unknowns: value.unknowns.filter((item): item is string => typeof item === "string"),
    limitations: value.limitations.filter((item): item is string => typeof item === "string"),
  };
}
