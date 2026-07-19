import type { BrokerPosition, BuildPositionsResult, Instrument, Position, ReconciliationResult, Transaction } from "./types";

const STORAGE_KEY = "zxlab.risk.ledger.v1";
const BROKER_KEY = "zxlab.risk.broker-positions.v1";
const MODE_KEY = "zxlab.risk.market-provider.v1";

export function stableFingerprint(input: Omit<Transaction, "fingerprint" | "importedAt">): string {
  const canonical = [input.account, input.instrumentId ?? "", input.type, input.side ?? "", input.quantity, input.price, input.fee, new Date(input.executedAt).toISOString()].join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface PortfolioRepository {
  hasLedger(): boolean;
  listTransactions(): Transaction[];
  appendTransactions(items: Transaction[]): { added: Transaction[]; duplicates: Transaction[] };
  clearTransactions(): void;
  replaceTransactions(items: Transaction[]): void;
  getBrokerPositions(): BrokerPosition[];
  saveBrokerPositions(items: BrokerPosition[]): void;
  getMarketMode(): "mock" | "api";
  setMarketMode(mode: "mock" | "api"): void;
}

export class LocalPortfolioRepository implements PortfolioRepository {
  constructor(private readonly storage: Storage) {}
  hasLedger() { return this.storage.getItem(STORAGE_KEY) !== null; }
  listTransactions(): Transaction[] { return this.read<Transaction[]>(STORAGE_KEY, []).sort((a, b) => a.executedAt.localeCompare(b.executedAt)); }
  appendTransactions(items: Transaction[]) {
    const current = this.listTransactions();
    const ids = new Set(current.map((item) => item.id));
    const fingerprints = new Set(current.map((item) => item.fingerprint));
    const added: Transaction[] = [];
    const duplicates: Transaction[] = [];
    for (const item of items) {
      if (ids.has(item.id) || fingerprints.has(item.fingerprint)) { duplicates.push(item); continue; }
      ids.add(item.id); fingerprints.add(item.fingerprint); added.push(item);
    }
    this.storage.setItem(STORAGE_KEY, JSON.stringify([...current, ...added]));
    return { added, duplicates };
  }
  clearTransactions() { this.storage.setItem(STORAGE_KEY, "[]"); this.storage.removeItem(BROKER_KEY); }
  replaceTransactions(items: Transaction[]) { this.storage.setItem(STORAGE_KEY, JSON.stringify(items)); }
  getBrokerPositions() { return this.read<BrokerPosition[]>(BROKER_KEY, []); }
  saveBrokerPositions(items: BrokerPosition[]) { this.storage.setItem(BROKER_KEY, JSON.stringify(items)); }
  getMarketMode() { return this.storage.getItem(MODE_KEY) === "mock" ? "mock" : "api"; }
  setMarketMode(mode: "mock" | "api") { this.storage.setItem(MODE_KEY, mode); }
  private read<T>(key: string, fallback: T): T { try { const value = this.storage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
}

export function buildPositions(transactions: Transaction[], instruments: Instrument[]): Position[] {
  return buildPositionsDetailed(transactions, instruments).positions;
}

export function buildPositionsDetailed(transactions: Transaction[], instruments: Instrument[]): BuildPositionsResult {
  const catalog = new Map(instruments.map((item) => [item.id, item]));
  const states = new Map<string, { quantity: number; costBasis: number; realizedPnl: number; fees: number; taxes: number; evidence: string[] }>();
  const anomalies: BuildPositionsResult["anomalies"] = [];
  for (const transaction of [...transactions].sort((a, b) => a.executedAt.localeCompare(b.executedAt))) {
    if (!transaction.instrumentId || ["DEPOSIT", "WITHDRAWAL"].includes(transaction.type)) continue;
    const instrument = catalog.get(transaction.instrumentId);
    if (!instrument) { anomalies.push({ id: `anomaly:unknown:${transaction.id}`, transactionId: transaction.id, instrumentId: transaction.instrumentId, kind: "unknown_instrument", message: `无法识别证券 ${transaction.instrumentId}` }); continue; }
    const state = states.get(instrument.id) ?? { quantity: 0, costBasis: 0, realizedPnl: 0, fees: 0, taxes: 0, evidence: [] };
    state.evidence.push(`transaction:${transaction.id}`);
    if (transaction.type === "BUY" || (transaction.type === "POSITION_ADJUSTMENT" && transaction.side !== "SELL")) {
      state.quantity += transaction.quantity;
      state.costBasis += transaction.quantity * transaction.price + transaction.fee;
      state.fees += transaction.fee;
    } else if (transaction.type === "SELL" || (transaction.type === "POSITION_ADJUSTMENT" && transaction.side === "SELL")) {
      const sold = Math.min(transaction.quantity, state.quantity);
      if (transaction.quantity > state.quantity) anomalies.push({ id: `anomaly:oversell:${transaction.id}`, transactionId: transaction.id, instrumentId: instrument.id, kind: "oversell", message: `卖出数量 ${transaction.quantity} 超过账本持仓 ${state.quantity}` });
      const averageCost = state.quantity > 0 ? state.costBasis / state.quantity : 0;
      state.realizedPnl += sold * transaction.price - transaction.fee - sold * averageCost;
      state.quantity -= sold;
      state.costBasis -= sold * averageCost;
      state.fees += transaction.fee;
      if (state.quantity <= 1e-8) { state.quantity = 0; state.costBasis = 0; }
    } else if (transaction.type === "FEE") {
      const amount = transaction.fee || transaction.price;
      state.fees += amount; state.realizedPnl -= amount;
    } else if (transaction.type === "TAX") {
      const amount = transaction.fee || transaction.price;
      state.taxes += amount; state.realizedPnl -= amount;
    } else if (transaction.type === "DIVIDEND") {
      state.realizedPnl += transaction.price || transaction.quantity;
    }
    states.set(instrument.id, state);
  }
  const positions = [...states.entries()].filter(([, state]) => state.quantity > 0).map(([instrumentId, state]) => {
    const instrument = catalog.get(instrumentId)!;
    return { ...instrument, instrumentId, quantity: state.quantity, averageCost: state.quantity ? state.costBasis / state.quantity : 0, costBasis: state.costBasis, realizedPnl: state.realizedPnl, fees: state.fees, taxes: state.taxes, price: null, marketValue: null, unrealizedPnl: null, dayPnl: null, nominalWeight: null, effectiveExposure: null, planStatus: "missing" as const, quoteQuality: "unavailable" as const, quoteTime: "—", riskEventIds: [], transactionEvidenceIds: state.evidence };
  });
  return { positions, anomalies };
}

export function reconcilePositions(result: BuildPositionsResult, brokerPositions: BrokerPosition[]): ReconciliationResult {
  const broker = new Map(brokerPositions.map((item) => [item.instrumentId, item]));
  const items = result.positions.map((position) => {
    const actual = broker.get(position.instrumentId);
    const quantityDifference = actual ? actual.quantity - position.quantity : null;
    const costDifference = actual?.averageCost == null ? null : actual.averageCost - position.averageCost;
    const status = !actual ? "unverified" as const : Math.abs(quantityDifference!) < 1e-8 && (costDifference == null || Math.abs(costDifference) < 0.001) ? "matched" as const : "mismatch" as const;
    return { instrumentId: position.instrumentId, name: position.name, derivedQuantity: position.quantity, brokerQuantity: actual?.quantity ?? null, quantityDifference, derivedAverageCost: position.averageCost, brokerAverageCost: actual?.averageCost ?? null, costDifference, status };
  });
  const known = new Set(result.positions.map((item) => item.instrumentId));
  const unknownInstruments = brokerPositions.filter((item) => !known.has(item.instrumentId)).map((item) => item.instrumentId);
  return { items, unresolved: items.some((item) => item.status !== "matched") || unknownInstruments.length > 0 || result.anomalies.length > 0, unknownInstruments, anomalies: result.anomalies };
}

export function calculateCash(transactions: Transaction[]): number {
  return transactions.reduce((cash, item) => {
    if (item.type === "DEPOSIT") return cash + (item.price || item.quantity);
    if (item.type === "WITHDRAWAL") return cash - (item.price || item.quantity);
    if (item.type === "BUY") return cash - item.quantity * item.price - item.fee;
    if (item.type === "SELL") return cash + item.quantity * item.price - item.fee;
    if (item.type === "FEE" || item.type === "TAX") return cash - (item.fee || item.price);
    if (item.type === "DIVIDEND") return cash + (item.price || item.quantity);
    return cash;
  }, 0);
}
