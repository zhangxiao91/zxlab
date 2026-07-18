import assert from "node:assert/strict";
import test from "node:test";
import { createRiskBackup, previewRiskBackup, restoreRiskBackup } from "../src/features/risk/backup.ts";
import { calculateRisk } from "../src/features/risk/engine.ts";
import { LocalRiskJournalRepository } from "../src/features/risk/journal.ts";
import { buildPositionsDetailed, LocalPortfolioRepository, reconcilePositions } from "../src/features/risk/ledger.ts";
import { instruments, mockPortfolioHistory, mockQuotes, mockRiskRules, mockTradePlans, mockTransactions } from "../src/features/risk/mock.ts";
import { MockReviewService } from "../src/features/risk/review.ts";
import type { ReviewRun } from "../src/features/risk/types.ts";

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
  const backup = createRiskBackup(portfolio, journal, { tradePlans: mockTradePlans, riskRules: mockRiskRules, instruments });
  portfolio.clearTransactions(); journal.clear();
  const preview = previewRiskBackup(backup, portfolio, journal);
  assert.deepEqual(preview.counts, { transactions: mockTransactions.length, reviews: 1, feedback: 1, memories: 1 });
  restoreRiskBackup(preview, "overwrite", portfolio, journal);
  assert.equal(portfolio.listTransactions().length, mockTransactions.length);
  assert.equal(journal.listRuns()[0].evidencePack.id, run.evidencePack.id);
  assert.equal(journal.listFeedback().length, 1); assert.equal(journal.listMemoryCandidates().length, 1);
  const conflictPreview = previewRiskBackup(backup, portfolio, journal);
  assert.equal(conflictPreview.conflicts.transactions, mockTransactions.length); assert.equal(conflictPreview.conflicts.reviews, 1);
});

test("backup rejects unsupported schema versions", async () => {
  const { portfolio, journal } = await fixture();
  assert.throws(() => previewRiskBackup({ schemaVersion: "9.0.0" }, portfolio, journal), /不支持的备份版本/);
});
