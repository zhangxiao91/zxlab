import assert from "node:assert/strict";
import test from "node:test";
import { createRiskBackup, previewRiskBackup, restoreRiskBackup } from "../src/features/risk/backup.ts";
import { calculateRisk } from "../src/features/risk/engine.ts";
import { LocalRiskJournalRepository } from "../src/features/risk/journal.ts";
import { buildPositionsDetailed, LocalPortfolioRepository, reconcilePositions } from "../src/features/risk/ledger.ts";
import { instruments, mockPortfolioHistory, mockQuotes, mockRiskRules, mockTradePlans, mockTransactions } from "../src/features/risk/mock.ts";
import { MockReviewService } from "../src/features/risk/review.ts";
import type { Quote, ReviewRun } from "../src/features/risk/types.ts";
import { RiskWorkspaceService } from "../src/features/risk/workspace.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

async function fixture(storage = new MemoryStorage()) {
  const portfolio = new LocalPortfolioRepository(storage); portfolio.replaceTransactions(mockTransactions);
  const journal = new LocalRiskJournalRepository(storage);
  const built = buildPositionsDetailed(mockTransactions, instruments);
  const reconciliation = reconcilePositions(built, built.positions.map((item) => ({ instrumentId: item.instrumentId, quantity: item.quantity, averageCost: item.averageCost })));
  const risk = calculateRisk({ transactions: mockTransactions, positions: built.positions, quotes: mockQuotes, tradePlans: mockTradePlans, riskRules: mockRiskRules, portfolioHistory: mockPortfolioHistory, reconciliation, now: "2026-07-18T14:32:11+08:00" });
  const execution = await new MockReviewService().review(risk.evidencePack);
  const run: ReviewRun = {
    id: "review-run-1", reviewDate: "2026-07-18", createdAt: "2026-07-18T15:00:00+08:00",
    evidencePack: risk.evidencePack,
    riskSnapshot: { calculatedAt: risk.evidencePack.generatedAt, portfolio: { ...risk.portfolio, dayReturn: 0, currentDrawdown: 0, maxDrawdown: 0, riskBudgetUsed: 0 }, positions: risk.positions, metrics: risk.metrics, events: risk.events, reconciliation, warnings: risk.warnings },
    marketDataTimestamp: mockQuotes.at(-1)?.marketTimestamp ?? null, riskRuleVersion: "risk-rules.v1.2", evidenceSchemaVersion: "evidence-pack.v1.2", promptVersion: execution.promptVersion,
    provider: execution.provider, model: execution.model, fallbackPath: execution.fallbackPath, requestDurationMs: execution.requestDurationMs, inputTokens: null, outputTokens: null, estimatedCost: 0,
    status: "success", result: execution.result, rawStructuredOutput: execution.rawStructuredOutput, warnings: [], errors: [],
  };
  return { storage, portfolio, journal, run };
}

test("ReviewRun freezes evidence and feedback creates reviewable memory candidates", async () => {
  const { journal, run } = await fixture();
  journal.saveRun(run);
  run.evidencePack.warnings.push("later mutation");
  assert.equal(journal.findRun(run.id)?.evidencePack.warnings.includes("later mutation"), false);
  const itemId = run.result?.mainRisks[0]?.id ?? "review:item";
  journal.saveFeedback(run.id, { helpful: true, hasFactErrors: true, missingKeyFactors: true, note: "本次减仓是为了控制隔夜风险。", itemFeedback: [{ reviewItemId: itemId, rating: "missing-context", correction: "忽略了隔夜风险约束。", createdAt: "2026-07-18T15:02:00+08:00" }] });
  const candidates = journal.listMemoryCandidates();
  assert.equal(candidates.length, 2); assert.ok(candidates.every((item) => item.status === "pending"));
  journal.setMemoryStatus(candidates[0].id, "accepted");
  assert.equal(journal.listMemoryCandidates().find((item) => item.id === candidates[0].id)?.status, "accepted");
});

test("complete backup restores ledger, runs, feedback and candidates after clear", async () => {
  const { portfolio, journal, run } = await fixture();
  journal.saveRun(run);
  journal.saveFeedback(run.id, { helpful: false, hasFactErrors: false, missingKeyFactors: true, note: "需要补充策略上下文。", itemFeedback: [] });
  portfolio.saveBrokerSnapshot({ id: "snapshot-backup", snapshotAt: "2026-07-20T15:00:00+08:00", accountName: "测试账户", sourceKind: "csv", importedAt: "2026-07-20T15:00:01+08:00", positions: [{ instrumentId: "SSE:512480", quantity: 10000, averageCost: 0.92 }], rawDraftWarnings: [] });
  const backup = createRiskBackup(portfolio, journal, { tradePlans: mockTradePlans, riskRules: mockRiskRules, instruments });
  portfolio.clearTransactions(); journal.clear();
  const preview = previewRiskBackup(backup, portfolio, journal);
  assert.deepEqual(preview.counts, { transactions: mockTransactions.length, reviews: 1, feedback: 1, memories: 1 });
  restoreRiskBackup(preview, "overwrite", portfolio, journal);
  assert.equal(portfolio.listTransactions().length, mockTransactions.length);
  assert.equal(journal.listRuns()[0].evidencePack.id, run.evidencePack.id);
  assert.equal(journal.listFeedback().length, 1); assert.equal(journal.listMemoryCandidates().length, 1);
  assert.equal(portfolio.getBrokerSnapshot()?.id, "snapshot-backup");
  const conflictPreview = previewRiskBackup(backup, portfolio, journal);
  assert.equal(conflictPreview.conflicts.transactions, mockTransactions.length); assert.equal(conflictPreview.conflicts.reviews, 1);
});

test("backup rejects unsupported schema versions", async () => {
  const { portfolio, journal } = await fixture();
  assert.throws(() => previewRiskBackup({ schemaVersion: "9.0.0" }, portfolio, journal), /不支持的备份版本/);
});

test("market provider defaults to API and Mock requires an explicit local choice", () => {
  const storage = new MemoryStorage();
  const portfolio = new LocalPortfolioRepository(storage);
  assert.equal(portfolio.getMarketMode(), "api");
  portfolio.setMarketMode("mock");
  assert.equal(portfolio.getMarketMode(), "mock");
  portfolio.setMarketMode("api");
  assert.equal(portfolio.getMarketMode(), "api");
});

test("workspace reports API unavailable without falling back to Mock labels", async () => {
  const storage = new MemoryStorage();
  const portfolio = new LocalPortfolioRepository(storage);
  portfolio.replaceTransactions(mockTransactions);
  const built = buildPositionsDetailed(mockTransactions, instruments);
  portfolio.saveBrokerPositions(built.positions.map((position) => ({ instrumentId: position.instrumentId, quantity: position.quantity, averageCost: position.averageCost })));
  const journal = new LocalRiskJournalRepository(storage);
  const unavailableQuotes: Quote[] = built.positions.map((position) => ({
    instrumentId: position.instrumentId,
    price: null,
    previousClose: null,
    open: null,
    high: null,
    low: null,
    volume: null,
    turnover: null,
    marketTimestamp: null,
    receivedAt: "2026-07-18T14:32:11+08:00",
    source: "risk-market-worker",
    quality: "unavailable",
    stale: true,
    warnings: ["全部行情上游不可用"],
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: unavailableQuotes })) as typeof fetch;
  try {
    const data = await new RiskWorkspaceService(portfolio, journal).load();
    const market = data.sourceHealth.find((source) => source.name === "ApiMarketDataProvider");
    assert.equal(data.dataMode, "api");
    assert.equal(market?.status, "offline");
    assert.equal(data.diagnostics.market.snapshotStatus, "unavailable");
    assert.deepEqual(data.diagnostics.market.errors, ["全部行情上游不可用"]);
    assert.ok(data.dataWarnings.some((warning) => warning.includes("ApiMarketDataProvider")));
    assert.equal(data.sourceHealth.some((source) => source.name === "MockMarketDataProvider"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("workspace keeps broker snapshots separate from ledger-derived positions", async () => {
  const storage = new MemoryStorage();
  const portfolio = new LocalPortfolioRepository(storage);
  portfolio.replaceTransactions(mockTransactions);
  const journal = new LocalRiskJournalRepository(storage);
  const workspace = new RiskWorkspaceService(portfolio, journal);
  const draft = {
    snapshotAt: "2026-07-20T15:00:00+08:00",
    accountName: "测试账户",
    sourceKind: "csv" as const,
    positions: [
      { rawName: "半导体ETF", rawSymbol: "512480", instrumentId: "SSE:512480", quantity: 10000, availableQuantity: null, averageCost: 0.92, marketValue: null, unrealizedPnl: null, currency: "CNY", confidence: 0.91, warnings: [] },
    ],
    unresolvedRows: [],
    warnings: [],
  };
  workspace.saveBrokerSnapshot({ id: "snapshot-1", snapshotAt: draft.snapshotAt, accountName: draft.accountName, sourceKind: draft.sourceKind, importedAt: "2026-07-20T15:00:01+08:00", positions: [{ instrumentId: "SSE:512480", quantity: 10000, averageCost: 0.92 }], rawDraftWarnings: [] });
  assert.equal(portfolio.getBrokerSnapshot()?.positions[0].instrumentId, "SSE:512480");
  assert.equal(portfolio.listTransactions().length, mockTransactions.length);
});

test("workspace treats weekend stale quotes as a closed-market snapshot", async () => {
  const storage = new MemoryStorage();
  const portfolio = new LocalPortfolioRepository(storage);
  portfolio.replaceTransactions(mockTransactions);
  const built = buildPositionsDetailed(mockTransactions, instruments);
  portfolio.saveBrokerPositions(built.positions.map((position) => ({ instrumentId: position.instrumentId, quantity: position.quantity, averageCost: position.averageCost })));
  const journal = new LocalRiskJournalRepository(storage);
  const weekendQuotes: Quote[] = mockQuotes.map((quote) => ({
    ...quote,
    marketTimestamp: quote.instrumentId === "SSE:513100" ? "2026-07-17T16:14:52+08:00" : quote.instrumentId === "SZSE:159995" ? "2026-07-17T16:14:27+08:00" : "2026-07-17T16:14:36+08:00",
    receivedAt: "2026-07-19T14:04:41+08:00",
    source: "tencent-qt",
    quality: "stale",
    stale: true,
    warnings: ["报价已过期"],
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: weekendQuotes })) as typeof fetch;
  try {
    const data = await new RiskWorkspaceService(portfolio, journal, new MockReviewService(), () => "2026-07-19T14:04:41+08:00").load();
    const market = data.sourceHealth.find((source) => source.name === "ApiMarketDataProvider");
    assert.equal(data.diagnostics.market.snapshotStatus, "closed-snapshot");
    assert.equal(data.diagnostics.market.stale, false);
    assert.equal(data.portfolio.reliable, true);
    assert.equal(data.dataWarnings.some((warning) => warning.includes("行情过期")), false);
    assert.match(market?.freshness ?? "", /闭市快照/);
    assert.equal(data.workflow.find((step) => step.id === "market")?.detail, "闭市快照可用于复盘");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
