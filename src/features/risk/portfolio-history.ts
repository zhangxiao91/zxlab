import type { MarketBar, PortfolioHistoryPoint, Quote, Transaction } from "./types";

interface PortfolioHistoryInput {
  transactions: Transaction[];
  bars: MarketBar[];
  quotes: Quote[];
  valuationAt: string;
}

interface PositionState { quantity: number }

export function buildPortfolioHistory(input: PortfolioHistoryInput): PortfolioHistoryPoint[] {
  if (!input.transactions.length) return [];

  const transactionsByDate = groupTransactions(input.transactions);
  const barsByDate = groupBars(input.bars);
  const valuationDate = shanghaiDate(input.valuationAt);
  const firstTransactionDate = [...transactionsByDate.keys()].sort()[0];
  const dates = [...new Set([...transactionsByDate.keys(), ...barsByDate.keys(), valuationDate])]
    .filter((date) => date >= firstTransactionDate && date <= valuationDate)
    .sort();
  const quoteById = new Map(input.quotes.map((quote) => [quote.instrumentId, quote]));
  const positions = new Map<string, PositionState>();
  const lastClose = new Map<string, number>();
  const points: PortfolioHistoryPoint[] = [];
  let cash = 0;
  let previousValue: number | null = null;
  let pendingExternalFlow = 0;
  let performanceIndex = 1;
  let peakIndex = 1;

  for (const date of dates) {
    for (const bar of barsByDate.get(date) ?? []) {
      if (bar.close != null && Number.isFinite(bar.close)) lastClose.set(bar.instrumentId, bar.close);
    }

    for (const transaction of transactionsByDate.get(date) ?? []) {
      cash = applyTransaction(cash, positions, transaction);
      pendingExternalFlow += externalFlow(transaction);
    }

    const valuation = valuePositions(positions, lastClose, date === valuationDate ? quoteById : undefined);
    if (valuation == null) continue;
    const value = cash + valuation;
    if (!Number.isFinite(value)) continue;

    if (previousValue != null) {
      const capitalAtRisk = previousValue + pendingExternalFlow;
      if (capitalAtRisk > 0) performanceIndex *= value / capitalAtRisk;
      peakIndex = Math.max(peakIndex, performanceIndex);
    }
    const drawdown = peakIndex > 0 ? Math.min(0, performanceIndex / peakIndex - 1) : 0;
    points.push({ date: date.slice(5), value, drawdown });
    previousValue = value;
    pendingExternalFlow = 0;
  }

  return points;
}

function groupTransactions(transactions: Transaction[]): Map<string, Transaction[]> {
  const grouped = new Map<string, Transaction[]>();
  for (const transaction of [...transactions].sort((left, right) => left.executedAt.localeCompare(right.executedAt))) {
    const date = shanghaiDate(transaction.executedAt);
    grouped.set(date, [...(grouped.get(date) ?? []), transaction]);
  }
  return grouped;
}

function groupBars(bars: MarketBar[]): Map<string, MarketBar[]> {
  const grouped = new Map<string, MarketBar[]>();
  for (const bar of bars) {
    const date = marketDate(bar.timestamp);
    if (!date) continue;
    grouped.set(date, [...(grouped.get(date) ?? []), bar]);
  }
  return grouped;
}

function applyTransaction(cash: number, positions: Map<string, PositionState>, transaction: Transaction): number {
  if (transaction.type === "DEPOSIT") return cash + (transaction.price || transaction.quantity);
  if (transaction.type === "WITHDRAWAL") return cash - (transaction.price || transaction.quantity);
  if (transaction.type === "FEE" || transaction.type === "TAX") return cash - (transaction.fee || transaction.price);
  if (transaction.type === "DIVIDEND") return cash + (transaction.price || transaction.quantity);
  if (!transaction.instrumentId) return cash;

  const state = positions.get(transaction.instrumentId) ?? { quantity: 0 };
  if (transaction.type === "BUY") {
    state.quantity += transaction.quantity;
    cash -= transaction.quantity * transaction.price + transaction.fee;
  } else if (transaction.type === "SELL") {
    const sold = Math.min(transaction.quantity, state.quantity);
    state.quantity -= sold;
    cash += sold * transaction.price - transaction.fee;
  } else if (transaction.type === "POSITION_ADJUSTMENT") {
    state.quantity = transaction.side === "SELL"
      ? Math.max(0, state.quantity - transaction.quantity)
      : state.quantity + transaction.quantity;
  }
  positions.set(transaction.instrumentId, state);
  return cash;
}

function valuePositions(positions: Map<string, PositionState>, prices: Map<string, number>, currentQuotes?: Map<string, Quote>): number | null {
  let value = 0;
  for (const [instrumentId, position] of positions) {
    if (position.quantity <= 0) continue;
    const price = currentQuotes ? currentQuotes.get(instrumentId)?.price : prices.get(instrumentId);
    if (price == null || !Number.isFinite(price)) return null;
    value += position.quantity * price;
  }
  return value;
}

function externalFlow(transaction: Transaction): number {
  if (transaction.type === "DEPOSIT") return transaction.price || transaction.quantity;
  if (transaction.type === "WITHDRAWAL") return -(transaction.price || transaction.quantity);
  return 0;
}

function marketDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? shanghaiDate(value) : null;
}

function shanghaiDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
