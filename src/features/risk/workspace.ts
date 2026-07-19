import { calculateRisk } from "./engine";
import { LocalRiskJournalRepository } from "./journal";
import { buildPositionsDetailed, reconcilePositions, type PortfolioRepository } from "./ledger";
import { ApiMarketDataProvider, MockMarketDataProvider, type MarketDataProvider } from "./market";
import { instruments, mockPortfolioHistory, mockRiskRules, mockTradePlans, mockTransactions } from "./mock";
import { MockReviewService, type ReviewService } from "./review";
import type { ActivityItem, DailyWorkflowStep, MarketDiagnostics, MarketProviderMode, PortfolioDiagnostics, Quote, RiskDashboardData, Transaction } from "./types";

export const RISK_RULE_VERSION = "risk-rules.v1.2";
export const EVIDENCE_SCHEMA_VERSION = "evidence-pack.v1.2";

export class RiskWorkspaceService {
  constructor(private readonly repository: PortfolioRepository, private readonly journal: LocalRiskJournalRepository, private readonly reviewService: ReviewService = new MockReviewService()) {}
  ensureSeeded() { if (!this.repository.hasLedger()) this.repository.replaceTransactions(mockTransactions); }
  async load(): Promise<RiskDashboardData> {
    this.ensureSeeded();
    const transactions = this.repository.listTransactions();
    const mode = this.repository.getMarketMode();
    const built = buildPositionsDetailed(transactions, instruments);
    const reconciliation = reconcilePositions(built, this.repository.getBrokerPositions());
    let quotes: Quote[] = [], marketError: string | null = null;
    const provider: MarketDataProvider = mode === "api" ? new ApiMarketDataProvider() : new MockMarketDataProvider();
    const marketStarted = Date.now();
    try {
      quotes = await provider.getQuotes(built.positions.map((item) => item.instrumentId));
      if (mode === "api" && quotes.length > 0 && quotes.every((item) => item.quality === "unavailable")) marketError = "全部行情上游不可用";
    }
    catch (error) { marketError = error instanceof Error ? error.message : "行情网关失败"; }
    const marketFinished = new Date().toISOString();
    const previousOperations = this.journal.getOperations();
    const quoteWarnings = quotes.flatMap((item) => item.warnings);
    const marketDiagnostics: MarketDiagnostics = {
      provider: provider.name,
      lastSuccessAt: quotes.length ? marketFinished : previousOperations.market.lastSuccessAt,
      lastFailureAt: marketError ? marketFinished : previousOperations.market.lastFailureAt,
      requestDurationMs: Date.now() - marketStarted,
      dataTimestamp: latest(quotes.map((item) => item.marketTimestamp)),
      stale: Boolean(marketError) || !quotes.length || quotes.some((item) => item.stale),
      warnings: quoteWarnings,
      errors: marketError ? [marketError] : [],
    };
    this.journal.saveMarket(marketDiagnostics);
    const riskStarted = Date.now();
    const calculated = calculateRisk({ transactions, positions: built.positions, quotes, tradePlans: mockTradePlans, riskRules: mockRiskRules, portfolioHistory: mockPortfolioHistory, reconciliation });
    const riskDurationMs = Date.now() - riskStarted;
    if (marketError) { calculated.warnings.unshift(`ApiMarketDataProvider: ${marketError}`); calculated.evidencePack.warnings.unshift(`ApiMarketDataProvider: ${marketError}`); }
    const reviewExecution = await this.reviewService.review(calculated.evidencePack);
    const review = reviewExecution.result;
    const now = calculated.evidencePack.generatedAt;
    const analysisDate = localDate(now);
    const marketSources = [...new Set(quotes.map((item) => item.source))];
    const fallbackCount = quotes.filter((item) => item.fallbackUsed).length;
    const unavailableCount = quotes.filter((item) => item.quality === "unavailable").length;
    const history = [...mockPortfolioHistory.slice(0, -1), { date: new Date(now).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replace("/", "-"), value: calculated.portfolio.netValue, drawdown: mockPortfolioHistory.at(-1)?.drawdown ?? 0 }];
    const activity: ActivityItem[] = [
      ...calculated.events.map((item) => ({ id: `activity:${item.id}`, time: item.triggeredAt.slice(11, 16), type: "rule" as const, title: item.title, detail: item.message, evidenceId: item.id, tone: item.severity === "critical" || item.severity === "high" ? "danger" as const : "warning" as const })),
      ...[...transactions].reverse().map((item) => ({ id: `activity:transaction:${item.id}`, time: item.executedAt.slice(11, 16), type: "trade" as const, title: `${item.type} ${item.instrumentId ?? item.account}`, detail: `${item.quantity ? `${item.quantity} 份 · ` : ""}${item.price ? `价格/金额 ${item.price}` : "现金事件"} · 费用 ${item.fee}`, evidenceId: `transaction:${item.id}`, tone: item.type === "SELL" || item.type === "DIVIDEND" ? "positive" as const : "neutral" as const })),
    ].sort((a, b) => b.time.localeCompare(a.time));
    const operations = this.journal.getOperations();
    const portfolioDiagnostics: PortfolioDiagnostics = {
      ...operations.portfolio,
      unknownInstruments: [...new Set([...reconciliation.unknownInstruments, ...built.anomalies.filter((item) => item.kind === "unknown_instrument").map((item) => item.instrumentId).filter((item): item is string => Boolean(item))])],
      reconciliationDifferences: reconciliation.items.filter((item) => item.status !== "matched").length + reconciliation.unknownInstruments.length,
    };
    this.journal.savePortfolio(portfolioDiagnostics);
    const reviewRuns = this.journal.listRuns();
    const currentRun = reviewRuns.find((run) => run.reviewDate === analysisDate && run.evidencePack.id === calculated.evidencePack.id);
    const workflow = workflowSteps({ transactions, reconciliationUnresolved: reconciliation.unresolved, market: marketDiagnostics, riskWarnings: calculated.warnings, currentRunStatus: currentRun?.status, complete: this.journal.isDateComplete(analysisDate) });
    return {
      asOf: now, receivedAt: now, accountName: "个人交易账户", currency: "CNY", dataMode: mode,
      portfolio: { ...calculated.portfolio, dayReturn: calculated.portfolio.netValue ? calculated.portfolio.dayPnl / calculated.portfolio.netValue : 0, currentDrawdown: history.at(-1)?.drawdown ?? 0, maxDrawdown: Math.min(...history.map((item) => item.drawdown)), riskBudgetUsed: calculated.portfolio.netValue ? Math.abs(Math.min(0, calculated.portfolio.dayPnl)) / (calculated.portfolio.netValue * 0.025) : 0 },
      sourceHealth: [
        { name: provider.name, status: marketError ? "offline" : unavailableCount || fallbackCount || quotes.some((item) => item.stale) ? "degraded" : "healthy", latency: mode === "mock" ? "本地" : "三源网关", freshness: marketError ?? `${marketSources.join(" / ") || "无可用源"}${fallbackCount ? ` · ${fallbackCount} 项降级` : ""}` },
        { name: "本地交易账本", status: built.anomalies.length ? "degraded" : "healthy", latency: "浏览器", freshness: `${transactions.length} 条事件` },
        { name: "持仓对账", status: reconciliation.unresolved ? "degraded" : "healthy", latency: "本地", freshness: reconciliation.unresolved ? "待处理" : "一致" },
        { name: "Review Service", status: "healthy", latency: "本地", freshness: "Mock / Evidence Pack" },
      ],
      transactions, positions: calculated.positions, reconciliation, riskMetrics: calculated.metrics, riskEvents: calculated.events, activity, equityCurve: history, evidence: calculated.evidencePack.evidence, evidencePack: calculated.evidencePack, review, dataWarnings: calculated.warnings,
      analysisDate,
      riskCalculatedAt: now,
      workflow,
      diagnostics: {
        market: marketDiagnostics,
        portfolio: portfolioDiagnostics,
        risk: { executedAt: now, durationMs: riskDurationMs, inputPositionCount: built.positions.length, ruleCount: 4, triggeredEventCount: calculated.events.length, blockedMetricCount: calculated.metrics.filter((item) => !item.reliable).length, errors: [] },
        llm: operations.llm,
      },
      reviewRuns,
      memoryCandidates: this.journal.listMemoryCandidates(),
    };
  }
  importTransactions(items: Transaction[]) { return this.repository.appendTransactions(items); }
  clear() { this.repository.clearTransactions(); }
  restoreMock() { this.repository.replaceTransactions(mockTransactions); }
  setMode(mode: MarketProviderMode) { this.repository.setMarketMode(mode); }
  saveBrokerQuantity(instrumentId: string, quantity: number, averageCost: number | null) {
    const current = this.repository.getBrokerPositions().filter((item) => item.instrumentId !== instrumentId);
    this.repository.saveBrokerPositions([...current, { instrumentId, quantity, averageCost }]);
  }
}

function latest(values: Array<string | null>): string | null { return values.filter((item): item is string => Boolean(item)).sort().at(-1) ?? null; }
function localDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function workflowSteps(input: { transactions: Transaction[]; reconciliationUnresolved: boolean; market: MarketDiagnostics; riskWarnings: string[]; currentRunStatus?: "pending" | "success" | "partial" | "failed"; complete: boolean }): DailyWorkflowStep[] {
  return [
    { id: "transactions", label: "更新交易数据", status: input.transactions.length ? "success" : "pending", detail: input.transactions.length ? `${input.transactions.length} 条账本事件` : "等待导入或录入" },
    { id: "reconciliation", label: "检查持仓对账", status: input.reconciliationUnresolved ? "needs-confirmation" : "success", detail: input.reconciliationUnresolved ? "存在未确认差异" : "数量与成本已核对" },
    { id: "market", label: "检查行情新鲜度", status: input.market.errors.length ? "error" : input.market.stale ? "warning" : "success", detail: input.market.errors[0] ?? (input.market.stale ? "存在过期或缺失行情" : "行情时间通过检查") },
    { id: "risk", label: "执行风险评估", status: input.riskWarnings.length ? "warning" : "success", detail: input.riskWarnings.length ? `${input.riskWarnings.length} 项质量限制` : "确定性计算完成" },
    { id: "review", label: "生成操作复盘", status: input.currentRunStatus === "success" ? "success" : input.currentRunStatus === "partial" ? "warning" : input.currentRunStatus === "failed" ? "error" : "pending", detail: input.currentRunStatus ? `本日运行 ${input.currentRunStatus}` : "等待手动生成" },
    { id: "complete", label: "完成当日记录", status: input.complete ? "success" : input.currentRunStatus ? "needs-confirmation" : "pending", detail: input.complete ? "已封存今日流程" : input.currentRunStatus ? "等待确认完成" : "先完成复盘" },
  ];
}
