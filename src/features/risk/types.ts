export type Severity = "critical" | "high" | "medium" | "low";
export type Quality = "live" | "cached" | "stale";

export interface Position {
  instrumentId: string;
  symbol: string;
  name: string;
  assetType: "stock" | "etf";
  quantity: number;
  averageCost: number;
  price: number;
  marketValue: number;
  unrealizedPnl: number;
  dayPnl: number;
  nominalWeight: number;
  leverageMultiplier: number;
  effectiveExposure: number;
  industry: string;
  themes: string[];
  planStatus: "aligned" | "overweight" | "missing";
  quoteQuality: Quality;
  quoteTime: string;
  riskEventIds: string[];
}

export interface RiskEvent {
  id: string;
  ruleId: string;
  severity: Severity;
  status: "active" | "resolved";
  title: string;
  message: string;
  actualValue: number | null;
  threshold: number | null;
  triggeredAt: string;
  evidenceIds: string[];
  dataWarnings: string[];
}

export interface ActivityItem {
  id: string;
  time: string;
  type: "trade" | "plan" | "rule" | "data" | "review";
  title: string;
  detail: string;
  evidenceId: string;
  tone: "neutral" | "warning" | "danger" | "positive";
}

export interface EvidenceItem {
  id: string;
  type: string;
  title: string;
  timestamp: string;
  source: string;
  payload: Record<string, string | number | boolean | null>;
}

export interface ReviewResult {
  mode: "mock" | "openai";
  summary: string;
  mainRisks: Array<{ title: string; explanation: string; severity: Severity; evidenceIds: string[] }>;
  planViolations: Array<{ title: string; detail: string; evidenceIds: string[] }>;
  operationReview: Array<{ category: string; observation: string; evidenceIds: string[] }>;
  counterfactuals: string[];
  unknowns: string[];
  questionsForUser: string[];
  limitations: string[];
}

export interface RiskDashboardData {
  asOf: string;
  receivedAt: string;
  accountName: string;
  currency: "CNY";
  portfolio: {
    netValue: number;
    marketValue: number;
    cash: number;
    nominalExposure: number;
    effectiveExposure: number;
    dayPnl: number;
    dayReturn: number;
    currentDrawdown: number;
    maxDrawdown: number;
    riskBudgetUsed: number;
    reliable: boolean;
  };
  sourceHealth: Array<{ name: string; status: "healthy" | "degraded" | "offline"; latency: string; freshness: string }>;
  positions: Position[];
  riskEvents: RiskEvent[];
  activity: ActivityItem[];
  equityCurve: Array<{ date: string; value: number; drawdown: number }>;
  evidence: EvidenceItem[];
  review: ReviewResult;
}
