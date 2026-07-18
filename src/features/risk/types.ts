export type Severity = "critical" | "high" | "medium" | "low";
export type Quality = "live" | "cached" | "stale" | "unavailable";
export type TransactionType = "BUY" | "SELL" | "FEE" | "TAX" | "DIVIDEND" | "DEPOSIT" | "WITHDRAWAL" | "POSITION_ADJUSTMENT";
export type MarketProviderMode = "mock" | "api";

export interface Transaction {
  id: string;
  account: string;
  instrumentId: string | null;
  type: TransactionType;
  side: "BUY" | "SELL" | null;
  quantity: number;
  price: number;
  fee: number;
  executedAt: string;
  fingerprint: string;
  importedAt: string;
}

export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  assetType: "stock" | "etf";
  industry: string;
  themes: string[];
  leverageMultiplier: number;
}

export interface Quote {
  instrumentId: string;
  price: number | null;
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  turnover: number | null;
  marketTimestamp: string | null;
  receivedAt: string;
  source: string;
  quality: Quality;
  stale: boolean;
  warnings: string[];
  fallbackUsed?: boolean;
  providerAttempts?: Array<{ provider: string; ok: boolean; latencyMs: number; errorCode: string | null; message: string | null }>;
}

export interface MarketBar {
  instrumentId: string;
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  turnover: number | null;
}

export interface Position {
  instrumentId: string;
  symbol: string;
  name: string;
  assetType: "stock" | "etf";
  quantity: number;
  averageCost: number;
  costBasis: number;
  realizedPnl: number;
  fees: number;
  taxes: number;
  price: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  dayPnl: number | null;
  nominalWeight: number | null;
  leverageMultiplier: number;
  effectiveExposure: number | null;
  industry: string;
  themes: string[];
  planStatus: "aligned" | "overweight" | "missing";
  quoteQuality: Quality;
  quoteTime: string;
  riskEventIds: string[];
  transactionEvidenceIds: string[];
}

export interface LedgerAnomaly {
  id: string;
  transactionId: string;
  instrumentId: string | null;
  kind: "unknown_instrument" | "oversell" | "invalid_adjustment" | "duplicate";
  message: string;
}

export interface BuildPositionsResult { positions: Position[]; anomalies: LedgerAnomaly[] }
export interface BrokerPosition { instrumentId: string; quantity: number; averageCost: number | null }
export interface ReconciliationItem {
  instrumentId: string;
  name: string;
  derivedQuantity: number;
  brokerQuantity: number | null;
  quantityDifference: number | null;
  derivedAverageCost: number;
  brokerAverageCost: number | null;
  costDifference: number | null;
  status: "matched" | "unverified" | "mismatch";
}
export interface ReconciliationResult { items: ReconciliationItem[]; unresolved: boolean; unknownInstruments: string[]; anomalies: LedgerAnomaly[] }

export interface TradePlan { instrumentId: string; maxWeight: number; evidenceId: string }
export interface RiskRules { maxSinglePosition: number; maxThemeConcentration: number; maxEffectiveExposure: number; quoteStaleSeconds: number }
export interface PortfolioHistoryPoint { date: string; value: number; drawdown: number }

export interface CalculationTrace {
  inputs: Record<string, number | string | boolean | null>;
  formula: string;
  intermediate: Record<string, number | string | boolean | null>;
  finalResult: number | boolean | null;
  dataSources: string[];
  dataTimes: string[];
}
export interface RiskMetric { id: string; label: string; value: number | null; reliable: boolean; calculation: CalculationTrace; evidenceIds: string[] }
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

export interface ActivityItem { id: string; time: string; type: "trade" | "plan" | "rule" | "data" | "review"; title: string; detail: string; evidenceId: string; tone: "neutral" | "warning" | "danger" | "positive" }
export interface EvidenceItem { id: string; type: string; title: string; timestamp: string; source: string; payload: Record<string, string | number | boolean | null> }
export interface EvidencePack { id: string; generatedAt: string; reliable: boolean; evidence: EvidenceItem[]; metrics: RiskMetric[]; events: RiskEvent[]; warnings: string[] }
export interface ReviewResult {
  mode: "mock" | "llm";
  generatedAt: string;
  evidencePackFingerprint: string;
  provider?: string;
  model?: string;
  fallbackIndex?: number;
  requestId?: string;
  fallbackReason?: string;
  summary: string;
  mainRisks: Array<{ title: string; explanation: string; severity: Severity; evidenceIds: string[] }>;
  planViolations: Array<{ title: string; detail: string; evidenceIds: string[] }>;
  operationReview: Array<{ category: string; observation: string; evidenceIds: string[] }>;
  counterfactuals: string[];
  unknowns: string[];
  questionsForUser: string[];
  limitations: string[];
}

export interface CsvFieldMapping { id: string; account: string; instrumentId: string; type: string; side: string; quantity: string; price: string; fee: string; executedAt: string }
export interface CsvRowError { rowNumber: number; raw: Record<string, string>; errors: string[] }
export interface CsvPreview { headers: string[]; mapping: CsvFieldMapping; valid: Transaction[]; invalid: CsvRowError[]; duplicates: Array<{ rowNumber: number; id: string; reason: string }> }

export interface RiskDashboardData {
  asOf: string; receivedAt: string; accountName: string; currency: "CNY"; dataMode: MarketProviderMode;
  portfolio: { netValue: number; marketValue: number; cash: number; nominalExposure: number; effectiveExposure: number; dayPnl: number; dayReturn: number; currentDrawdown: number; maxDrawdown: number; riskBudgetUsed: number; reliable: boolean };
  sourceHealth: Array<{ name: string; status: "healthy" | "degraded" | "offline"; latency: string; freshness: string }>;
  transactions: Transaction[]; positions: Position[]; reconciliation: ReconciliationResult; riskMetrics: RiskMetric[]; riskEvents: RiskEvent[]; activity: ActivityItem[];
  equityCurve: PortfolioHistoryPoint[]; evidence: EvidenceItem[]; evidencePack: EvidencePack; review: ReviewResult; dataWarnings: string[];
}
