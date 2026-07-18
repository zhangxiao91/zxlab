import { calculateRisk } from "./engine";
import { buildPositionsDetailed, reconcilePositions, type PortfolioRepository } from "./ledger";
import { ApiMarketDataProvider, MockMarketDataProvider, type MarketDataProvider } from "./market";
import { instruments, mockPortfolioHistory, mockRiskRules, mockTradePlans, mockTransactions } from "./mock";
import { MockReviewService, type ReviewService } from "./review";
import type { ActivityItem, MarketProviderMode, Quote, RiskDashboardData, Transaction } from "./types";

export class RiskWorkspaceService {
  constructor(private readonly repository: PortfolioRepository, private readonly reviewService: ReviewService = new MockReviewService()) {}
  ensureSeeded() { if (!this.repository.hasLedger()) this.repository.replaceTransactions(mockTransactions); }
  async load(): Promise<RiskDashboardData> {
    this.ensureSeeded();
    const transactions = this.repository.listTransactions();
    const mode = this.repository.getMarketMode();
    const built = buildPositionsDetailed(transactions, instruments);
    const reconciliation = reconcilePositions(built, this.repository.getBrokerPositions());
    let quotes: Quote[] = [], marketError: string | null = null;
    const provider: MarketDataProvider = mode === "api" ? new ApiMarketDataProvider() : new MockMarketDataProvider();
    try { quotes = await provider.getQuotes(built.positions.map((item) => item.instrumentId)); }
    catch (error) { marketError = error instanceof Error ? error.message : "行情网关失败"; }
    const calculated = calculateRisk({ transactions, positions: built.positions, quotes, tradePlans: mockTradePlans, riskRules: mockRiskRules, portfolioHistory: mockPortfolioHistory, reconciliation });
    if (marketError) { calculated.warnings.unshift(`ApiMarketDataProvider: ${marketError}`); calculated.evidencePack.warnings.unshift(`ApiMarketDataProvider: ${marketError}`); }
    const review = await this.reviewService.review(calculated.evidencePack);
    const now = calculated.evidencePack.generatedAt;
    const marketSources = [...new Set(quotes.map((item) => item.source))];
    const fallbackCount = quotes.filter((item) => item.fallbackUsed).length;
    const unavailableCount = quotes.filter((item) => item.quality === "unavailable").length;
    const history = [...mockPortfolioHistory.slice(0, -1), { date: new Date(now).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replace("/", "-"), value: calculated.portfolio.netValue, drawdown: mockPortfolioHistory.at(-1)?.drawdown ?? 0 }];
    const activity: ActivityItem[] = [
      ...calculated.events.map((item) => ({ id: `activity:${item.id}`, time: item.triggeredAt.slice(11, 16), type: "rule" as const, title: item.title, detail: item.message, evidenceId: item.id, tone: item.severity === "critical" || item.severity === "high" ? "danger" as const : "warning" as const })),
      ...[...transactions].reverse().map((item) => ({ id: `activity:transaction:${item.id}`, time: item.executedAt.slice(11, 16), type: "trade" as const, title: `${item.type} ${item.instrumentId ?? item.account}`, detail: `${item.quantity ? `${item.quantity} 份 · ` : ""}${item.price ? `价格/金额 ${item.price}` : "现金事件"} · 费用 ${item.fee}`, evidenceId: `transaction:${item.id}`, tone: item.type === "SELL" || item.type === "DIVIDEND" ? "positive" as const : "neutral" as const })),
    ].sort((a, b) => b.time.localeCompare(a.time));
    return {
      asOf: now, receivedAt: now, accountName: "个人交易账户", currency: "CNY", dataMode: mode,
      portfolio: { ...calculated.portfolio, dayReturn: calculated.portfolio.netValue ? calculated.portfolio.dayPnl / calculated.portfolio.netValue : 0, currentDrawdown: history.at(-1)?.drawdown ?? 0, maxDrawdown: Math.min(...history.map((item) => item.drawdown)), riskBudgetUsed: calculated.portfolio.netValue ? Math.abs(Math.min(0, calculated.portfolio.dayPnl)) / (calculated.portfolio.netValue * 0.025) : 0 },
      sourceHealth: [
        { name: provider.name, status: marketError || unavailableCount ? "offline" : fallbackCount || quotes.some((item) => item.stale) ? "degraded" : "healthy", latency: mode === "mock" ? "本地" : "三源网关", freshness: marketError ?? `${marketSources.join(" / ") || "无可用源"}${fallbackCount ? ` · ${fallbackCount} 项降级` : ""}` },
        { name: "本地交易账本", status: built.anomalies.length ? "degraded" : "healthy", latency: "浏览器", freshness: `${transactions.length} 条事件` },
        { name: "持仓对账", status: reconciliation.unresolved ? "degraded" : "healthy", latency: "本地", freshness: reconciliation.unresolved ? "待处理" : "一致" },
        { name: "Review Service", status: "healthy", latency: "本地", freshness: "Mock / Evidence Pack" },
      ],
      transactions, positions: calculated.positions, reconciliation, riskMetrics: calculated.metrics, riskEvents: calculated.events, activity, equityCurve: history, evidence: calculated.evidencePack.evidence, evidencePack: calculated.evidencePack, review, dataWarnings: calculated.warnings,
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
