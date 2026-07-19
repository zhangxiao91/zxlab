export type Severity = "critical" | "high" | "medium" | "low";
export type Quality = "live" | "cached" | "stale" | "unavailable";
export type MarketSnapshotStatus = "live" | "closed-snapshot" | "stale" | "unavailable";
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
export interface RiskSnapshot {
  calculatedAt: string;
  portfolio: RiskDashboardData["portfolio"];
  positions: Position[];
  metrics: RiskMetric[];
  events: RiskEvent[];
  reconciliation: ReconciliationResult;
  warnings: string[];
}
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
  mainRisks: Array<{ id: string; title: string; explanation: string; severity: Severity; evidenceIds: string[] }>;
  planViolations: Array<{ id: string; title: string; detail: string; evidenceIds: string[] }>;
  operationReview: Array<{ id: string; category: string; observation: string; evidenceIds: string[] }>;
  counterfactuals: string[];
  unknowns: string[];
  questionsForUser: string[];
  limitations: string[];
}

export type ReviewRunStatus = "pending" | "success" | "partial" | "failed";
export type ReviewFeedbackRating = "accurate" | "partially-accurate" | "incorrect" | "missing-context";
export interface ReviewItemFeedback { reviewItemId: string; rating: ReviewFeedbackRating; correction: string; createdAt: string }
export interface ReviewFeedback {
  id: string;
  reviewRunId: string;
  helpful: boolean | null;
  hasFactErrors: boolean;
  missingKeyFactors: boolean;
  note: string;
  itemFeedback: ReviewItemFeedback[];
  createdAt: string;
  updatedAt: string;
}
export interface ReviewExecution {
  status: ReviewRunStatus;
  result: ReviewResult;
  rawStructuredOutput?: unknown;
  provider: string;
  model: string;
  fallbackPath: string[];
  requestDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  promptVersion: string;
  schemaValidation: "valid" | "partial" | "failed";
  retryCount: number | null;
  warnings: string[];
  errors: string[];
}
export interface ReviewRun {
  id: string;
  reviewDate: string;
  createdAt: string;
  evidencePack: EvidencePack;
  riskSnapshot: RiskSnapshot;
  marketDataTimestamp: string | null;
  riskRuleVersion: string;
  evidenceSchemaVersion: string;
  promptVersion: string;
  provider: string;
  model: string;
  fallbackPath: string[];
  requestDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  status: ReviewRunStatus;
  result: ReviewResult | null;
  rawStructuredOutput?: unknown;
  warnings: string[];
  errors: string[];
  userFeedback?: ReviewFeedback;
}
export interface MemoryCandidate {
  id: string;
  sourceReviewId: string;
  sourceFeedbackId: string;
  category: "risk-preference" | "trading-habit" | "strategy-context" | "instrument-context" | "one-off-context";
  content: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export type WorkflowStatus = "pending" | "running" | "success" | "warning" | "error" | "needs-confirmation";
export interface DailyWorkflowStep { id: "transactions" | "reconciliation" | "market" | "risk" | "review" | "complete"; label: string; status: WorkflowStatus; detail: string }
export interface MarketDiagnostics { provider: string; lastSuccessAt: string | null; lastFailureAt: string | null; requestDurationMs: number | null; dataTimestamp: string | null; stale: boolean; snapshotStatus: MarketSnapshotStatus; warnings: string[]; errors: string[] }
export interface PortfolioDiagnostics { lastImportAt: string | null; successRows: number; duplicateRows: number; failedRows: number; unknownInstruments: string[]; reconciliationDifferences: number }
export interface RiskDiagnostics { executedAt: string; durationMs: number; inputPositionCount: number; ruleCount: number; triggeredEventCount: number; blockedMetricCount: number; errors: string[] }
export interface LlmDiagnostics { provider: string | null; model: string | null; fallbackPath: string[]; promptVersion: string; requestDurationMs: number | null; inputTokens: number | null; outputTokens: number | null; estimatedCost: number | null; schemaValidation: "not-run" | "valid" | "partial" | "failed"; retryCount: number | null; finalError: string | null }
export interface RiskDiagnosticsBundle { market: MarketDiagnostics; portfolio: PortfolioDiagnostics; risk: RiskDiagnostics; llm: LlmDiagnostics }

export interface CsvFieldMapping { id: string; account: string; instrumentId: string; type: string; side: string; quantity: string; price: string; fee: string; executedAt: string }
export interface CsvRowError { rowNumber: number; raw: Record<string, string>; errors: string[] }
export interface CsvPreview { headers: string[]; mapping: CsvFieldMapping; valid: Transaction[]; invalid: CsvRowError[]; duplicates: Array<{ rowNumber: number; id: string; reason: string }> }

export interface RiskDashboardData {
  asOf: string; receivedAt: string; accountName: string; currency: "CNY"; dataMode: MarketProviderMode;
  portfolio: { netValue: number; marketValue: number; cash: number; nominalExposure: number; effectiveExposure: number; dayPnl: number; dayReturn: number; currentDrawdown: number; maxDrawdown: number; riskBudgetUsed: number; reliable: boolean };
  sourceHealth: Array<{ name: string; status: "healthy" | "degraded" | "offline"; latency: string; freshness: string }>;
  transactions: Transaction[]; positions: Position[]; reconciliation: ReconciliationResult; riskMetrics: RiskMetric[]; riskEvents: RiskEvent[]; activity: ActivityItem[];
  equityCurve: PortfolioHistoryPoint[]; evidence: EvidenceItem[]; evidencePack: EvidencePack; review: ReviewResult; dataWarnings: string[];
  analysisDate: string; riskCalculatedAt: string; workflow: DailyWorkflowStep[]; diagnostics: RiskDiagnosticsBundle;
  reviewRuns: ReviewRun[]; memoryCandidates: MemoryCandidate[];
}

export interface ToolResult<T> { ok: boolean; data: T | null; warnings: string[]; error: string | null }
export interface Announcement { id: string; instrumentId: string; publishedAt: string; title: string; url: string | null }
export interface IndustryPerformance { instrumentId: string; date: string; industry: string; returnPct: number | null; rank: number | null }
