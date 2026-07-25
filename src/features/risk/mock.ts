import { stableFingerprint } from "./ledger";
import { defaultInstruments, defaultRiskRules, defaultTradePlans } from "./config";
import type { PortfolioHistoryPoint, Quote, Transaction } from "./types";

export const instruments = defaultInstruments;

function transaction(input: Omit<Transaction, "fingerprint" | "importedAt">): Transaction { return { ...input, fingerprint: stableFingerprint(input), importedAt: "2026-07-18T14:32:11+08:00" }; }
export const mockTransactions: Transaction[] = [
  transaction({ id: "mock-deposit", account: "main", instrumentId: null, type: "DEPOSIT", side: null, quantity: 0, price: 1_200_000, fee: 0, executedAt: "2026-07-01T09:00:00+08:00" }),
  transaction({ id: "mock-001", account: "main", instrumentId: "SSE:512480", type: "BUY", side: "BUY", quantity: 300000, price: 0.862, fee: 5, executedAt: "2026-07-15T10:32:00+08:00" }),
  transaction({ id: "mock-002", account: "main", instrumentId: "SSE:512480", type: "BUY", side: "BUY", quantity: 100000, price: 0.878, fee: 5, executedAt: "2026-07-16T10:02:00+08:00" }),
  transaction({ id: "mock-003", account: "main", instrumentId: "SSE:512480", type: "SELL", side: "SELL", quantity: 50000, price: 0.891, fee: 5, executedAt: "2026-07-17T13:46:00+08:00" }),
  transaction({ id: "mock-004", account: "main", instrumentId: "SZSE:159995", type: "BUY", side: "BUY", quantity: 280000, price: 1.102, fee: 8, executedAt: "2026-07-16T14:02:18+08:00" }),
  transaction({ id: "mock-005", account: "main", instrumentId: "SSE:513100", type: "BUY", side: "BUY", quantity: 160000, price: 1.49, fee: 8, executedAt: "2026-07-18T09:36:00+08:00" }),
];

export const mockQuotes: Quote[] = [
  { instrumentId: "SSE:512480", price: 0.899, previousClose: 0.906, open: 0.904, high: 0.91, low: 0.892, volume: 812000000, turnover: 730000000, marketTimestamp: "2026-07-18T14:32:05+08:00", receivedAt: "2026-07-18T14:32:11+08:00", source: "mock-market", quality: "live", stale: false, warnings: [] },
  { instrumentId: "SZSE:159995", price: 1.054, previousClose: 1.071, open: 1.068, high: 1.076, low: 1.048, volume: 440000000, turnover: 466000000, marketTimestamp: "2026-07-18T14:32:04+08:00", receivedAt: "2026-07-18T14:32:11+08:00", source: "mock-market", quality: "live", stale: false, warnings: [] },
  { instrumentId: "SSE:513100", price: 1.522, previousClose: 1.571, open: 1.56, high: 1.566, low: 1.516, volume: 226000000, turnover: 347000000, marketTimestamp: "2026-07-18T14:27:41+08:00", receivedAt: "2026-07-18T14:32:11+08:00", source: "mock-market", quality: "stale", stale: true, warnings: ["报价超过 120 秒"] },
];

export const mockRiskRules = defaultRiskRules;
export const mockTradePlans = defaultTradePlans;
export const mockPortfolioHistory: PortfolioHistoryPoint[] = [
  { date: "07-01", value: 1200000, drawdown: 0 }, { date: "07-05", value: 1218000, drawdown: 0 }, { date: "07-10", value: 1196000, drawdown: -0.018 },
  { date: "07-15", value: 1229000, drawdown: 0 }, { date: "07-17", value: 1214000, drawdown: -0.012 }, { date: "07-18", value: 1186000, drawdown: -0.035 },
];
