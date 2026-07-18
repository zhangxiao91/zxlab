import assert from "node:assert/strict";
import test from "node:test";
import { previewCsv } from "../src/features/risk/csv.ts";
import { calculateRisk } from "../src/features/risk/engine.ts";
import { buildPositionsDetailed, reconcilePositions, stableFingerprint } from "../src/features/risk/ledger.ts";
import { instruments, mockPortfolioHistory, mockQuotes, mockRiskRules, mockTradePlans, mockTransactions } from "../src/features/risk/mock.ts";
import { MockReviewService } from "../src/features/risk/review.ts";
import type { Transaction } from "../src/features/risk/types.ts";

const tx = (input: Omit<Transaction, "fingerprint" | "importedAt">): Transaction => ({ ...input, fingerprint: stableFingerprint(input), importedAt: "2026-07-18T15:00:00+08:00" });

test("buildPositions handles weighted buys, partial sells, fees and realized pnl", () => {
  const catalog = [instruments[0]];
  const transactions = [
    tx({ id: "b1", account: "main", instrumentId: catalog[0].id, type: "BUY", side: "BUY", quantity: 100, price: 10, fee: 10, executedAt: "2026-07-01T10:00:00+08:00" }),
    tx({ id: "b2", account: "main", instrumentId: catalog[0].id, type: "BUY", side: "BUY", quantity: 100, price: 12, fee: 10, executedAt: "2026-07-02T10:00:00+08:00" }),
    tx({ id: "s1", account: "main", instrumentId: catalog[0].id, type: "SELL", side: "SELL", quantity: 50, price: 15, fee: 5, executedAt: "2026-07-03T10:00:00+08:00" }),
  ];
  const result = buildPositionsDetailed(transactions, catalog);
  assert.equal(result.positions[0].quantity, 150);
  assert.equal(result.positions[0].averageCost, 11.1);
  assert.equal(result.positions[0].costBasis, 1665);
  assert.equal(result.positions[0].realizedPnl, 190);
  assert.equal(result.positions[0].fees, 25);
});

test("full sell removes zero position and adjustment can create a position", () => {
  const result = buildPositionsDetailed([
    tx({ id: "b", account: "main", instrumentId: instruments[0].id, type: "BUY", side: "BUY", quantity: 10, price: 2, fee: 0, executedAt: "2026-07-01T10:00:00+08:00" }),
    tx({ id: "s", account: "main", instrumentId: instruments[0].id, type: "SELL", side: "SELL", quantity: 10, price: 3, fee: 0, executedAt: "2026-07-02T10:00:00+08:00" }),
    tx({ id: "a", account: "main", instrumentId: instruments[1].id, type: "POSITION_ADJUSTMENT", side: "BUY", quantity: 8, price: 1.2, fee: 0, executedAt: "2026-07-03T10:00:00+08:00" }),
  ], instruments);
  assert.deepEqual(result.positions.map((item) => item.instrumentId), [instruments[1].id]);
  assert.equal(result.positions[0].quantity, 8);
});

test("CSV preview keeps valid rows, isolates errors, and detects repeat imports", () => {
  const csv = "id,account,instrument_id,side,quantity,price,fee,executed_at\nnew-1,main,SSE:512480,BUY,10,0.8,1,2026-07-18T10:00:00+08:00\nbad,main,WRONG,BUY,x,0.8,0,nope";
  const first = previewCsv(csv);
  assert.equal(first.valid.length, 1); assert.equal(first.invalid.length, 1);
  const repeated = previewCsv(csv, undefined, first.valid);
  assert.equal(repeated.valid.length, 0); assert.equal(repeated.duplicates.length, 1); assert.equal(repeated.invalid.length, 1);
});

test("risk engine lowers reliability and emits stable evidence ids", async () => {
  const built = buildPositionsDetailed(mockTransactions, instruments);
  const reconciliation = reconcilePositions(built, built.positions.map((item) => ({ instrumentId: item.instrumentId, quantity: item.quantity, averageCost: item.averageCost })));
  const result = calculateRisk({ transactions: mockTransactions, positions: built.positions, quotes: mockQuotes, tradePlans: mockTradePlans, riskRules: mockRiskRules, portfolioHistory: mockPortfolioHistory, reconciliation, now: "2026-07-18T14:32:11+08:00" });
  assert.equal(result.positions.length, 3);
  assert.equal(result.portfolio.reliable, false);
  assert.ok(result.events.some((item) => item.ruleId === "data_quality.quote_stale"));
  assert.ok(result.metrics.every((item) => item.calculation.formula && item.evidenceIds.length));
  const ids = new Set(result.evidencePack.evidence.map((item) => item.id));
  assert.ok(result.events.flatMap((item) => item.evidenceIds).some((id) => ids.has(id)));
  const review = await new MockReviewService().review(result.evidencePack);
  assert.match(review.summary, /行情过期/);
  assert.ok(review.mainRisks.some((item) => item.evidenceIds.length > 0));
});
