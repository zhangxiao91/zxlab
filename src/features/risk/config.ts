import type { Instrument, RiskRules, TradePlan } from "./types";

export const defaultInstruments: Instrument[] = [
  { id: "SSE:512480", symbol: "512480", name: "半导体ETF", assetType: "etf", industry: "科技", themes: ["半导体", "硬科技"], leverageMultiplier: 1 },
  { id: "SZSE:159995", symbol: "159995", name: "芯片ETF", assetType: "etf", industry: "科技", themes: ["半导体", "硬科技"], leverageMultiplier: 1 },
  { id: "SSE:513100", symbol: "513100", name: "纳指ETF（三倍风险口径）", assetType: "etf", industry: "海外科技", themes: ["AI", "纳斯达克"], leverageMultiplier: 3 },
];

export const defaultRiskRules: RiskRules = { maxSinglePosition: 0.35, maxThemeConcentration: 0.45, maxEffectiveExposure: 1.2, quoteStaleSeconds: 120 };

export const defaultTradePlans: TradePlan[] = [
  { instrumentId: "SSE:512480", maxWeight: 0.32, evidenceId: "trade-plan:SSE:512480:v1" },
  { instrumentId: "SZSE:159995", maxWeight: 0.24, evidenceId: "trade-plan:SZSE:159995:v1" },
];
