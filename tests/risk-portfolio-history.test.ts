import assert from "node:assert/strict";
import test from "node:test";
import { stableFingerprint } from "../src/features/risk/ledger.ts";
import { buildPortfolioHistory } from "../src/features/risk/portfolio-history.ts";
import type { MarketBar, Quote, Transaction } from "../src/features/risk/types.ts";

const instrumentId = "SSE:512480";
const tx = (input: Omit<Transaction, "fingerprint" | "importedAt">): Transaction => ({ ...input, fingerprint: stableFingerprint(input), importedAt: "2026-07-04T15:00:00+08:00" });
const bar = (timestamp: string, close: number): MarketBar => ({ instrumentId, timestamp, open: close, high: close, low: close, close, volume: 1, turnover: 1 });
const quote = (price: number): Quote => ({ instrumentId, price, previousClose: 9, open: 9, high: price, low: 9, volume: 1, turnover: 1, marketTimestamp: "2026-07-04T15:00:00+08:00", receivedAt: "2026-07-04T15:01:00+08:00", source: "test", quality: "live", stale: false, warnings: [] });

test("rebuilds end-of-day equity and drawdown from ledger transactions and daily closes", () => {
  const transactions = [
    tx({ id: "deposit", account: "main", instrumentId: null, type: "DEPOSIT", side: null, quantity: 0, price: 1_000, fee: 0, executedAt: "2026-07-01T09:00:00+08:00" }),
    tx({ id: "buy", account: "main", instrumentId, type: "BUY", side: "BUY", quantity: 50, price: 10, fee: 0, executedAt: "2026-07-01T10:00:00+08:00" }),
  ];
  const points = buildPortfolioHistory({ transactions, bars: [bar("20260701", 10), bar("2026-07-02", 12), bar("2026-07-03", 9)], quotes: [quote(11)], valuationAt: "2026-07-04T15:01:00+08:00" });
  assert.deepEqual(points.map((point) => point.value), [1_000, 1_100, 950, 1_050]);
  assert.equal(points[0].drawdown, 0);
  assert.equal(points[1].drawdown, 0);
  assert.ok(Math.abs(points[2].drawdown - (950 / 1_100 - 1)) < 1e-12);
  assert.ok(Math.abs(points[3].drawdown - (1_050 / 1_100 - 1)) < 1e-12);
});

test("cash deposits and withdrawals do not create artificial performance or drawdown", () => {
  const transactions = [
    tx({ id: "deposit-1", account: "main", instrumentId: null, type: "DEPOSIT", side: null, quantity: 0, price: 1_000, fee: 0, executedAt: "2026-07-01T09:00:00+08:00" }),
    tx({ id: "deposit-2", account: "main", instrumentId: null, type: "DEPOSIT", side: null, quantity: 0, price: 500, fee: 0, executedAt: "2026-07-02T09:00:00+08:00" }),
    tx({ id: "withdraw", account: "main", instrumentId: null, type: "WITHDRAWAL", side: null, quantity: 0, price: 300, fee: 0, executedAt: "2026-07-03T09:00:00+08:00" }),
  ];
  const points = buildPortfolioHistory({ transactions, bars: [], quotes: [], valuationAt: "2026-07-03T15:01:00+08:00" });
  assert.deepEqual(points.map((point) => point.value), [1_000, 1_500, 1_200]);
  assert.deepEqual(points.map((point) => point.drawdown), [0, 0, 0]);
});

test("does not invent historical prices when a held instrument has no daily close", () => {
  const transactions = [
    tx({ id: "deposit", account: "main", instrumentId: null, type: "DEPOSIT", side: null, quantity: 0, price: 1_000, fee: 0, executedAt: "2026-07-01T09:00:00+08:00" }),
    tx({ id: "buy", account: "main", instrumentId, type: "BUY", side: "BUY", quantity: 50, price: 10, fee: 0, executedAt: "2026-07-02T10:00:00+08:00" }),
  ];
  const points = buildPortfolioHistory({ transactions, bars: [], quotes: [quote(11)], valuationAt: "2026-07-04T15:01:00+08:00" });
  assert.deepEqual(points.map((point) => point.date), ["07-01", "07-04"]);
  assert.equal(points.at(-1)?.value, 1_050);
});
