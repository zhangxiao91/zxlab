import type { PortfolioRepository } from "./ledger";
import type { RiskJournalSnapshot } from "./journal";
import { LocalRiskJournalRepository } from "./journal";
import type { Instrument, RiskRules, TradePlan, Transaction } from "./types";

export const RISK_BACKUP_SCHEMA_VERSION = "1.2.0";

export interface RiskBackup {
  schemaVersion: string;
  exportedAt: string;
  transactions: Transaction[];
  tradePlans: TradePlan[];
  riskRules: RiskRules;
  instrumentMetadata: Instrument[];
  reviews: RiskJournalSnapshot["reviews"];
  reviewFeedback: RiskJournalSnapshot["reviewFeedback"];
  memoryCandidates: RiskJournalSnapshot["memoryCandidates"];
  settings: {
    marketProviderMode: "mock" | "api";
    brokerPositions: ReturnType<PortfolioRepository["getBrokerPositions"]>;
  };
  operations: RiskJournalSnapshot["operations"];
}

export interface BackupPreview {
  backup: RiskBackup;
  counts: { transactions: number; reviews: number; feedback: number; memories: number };
  conflicts: { transactions: number; reviews: number; feedback: number; memories: number };
  warnings: string[];
}

export function createRiskBackup(repository: PortfolioRepository, journal: LocalRiskJournalRepository, config: { tradePlans: TradePlan[]; riskRules: RiskRules; instruments: Instrument[] }): RiskBackup {
  const snapshot = journal.snapshot();
  return {
    schemaVersion: RISK_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    transactions: repository.listTransactions(),
    tradePlans: config.tradePlans,
    riskRules: config.riskRules,
    instrumentMetadata: config.instruments,
    reviews: snapshot.reviews,
    reviewFeedback: snapshot.reviewFeedback,
    memoryCandidates: snapshot.memoryCandidates,
    settings: { marketProviderMode: repository.getMarketMode(), brokerPositions: repository.getBrokerPositions() },
    operations: snapshot.operations,
  };
}

export function previewRiskBackup(value: unknown, repository: PortfolioRepository, journal: LocalRiskJournalRepository): BackupPreview {
  const migrated = migrateBackup(value);
  const currentTransactions = repository.listTransactions();
  const currentJournal = journal.snapshot();
  const transactionIds = new Set(currentTransactions.map((item) => item.id));
  const transactionFingerprints = new Set(currentTransactions.map((item) => item.fingerprint));
  const conflicts = {
    transactions: migrated.transactions.filter((item) => transactionIds.has(item.id) || transactionFingerprints.has(item.fingerprint)).length,
    reviews: countIdConflicts(currentJournal.reviews, migrated.reviews),
    feedback: countIdConflicts(currentJournal.reviewFeedback, migrated.reviewFeedback),
    memories: countIdConflicts(currentJournal.memoryCandidates, migrated.memoryCandidates),
  };
  return {
    backup: migrated,
    counts: { transactions: migrated.transactions.length, reviews: migrated.reviews.length, feedback: migrated.reviewFeedback.length, memories: migrated.memoryCandidates.length },
    conflicts,
    warnings: migrated.schemaVersion === RISK_BACKUP_SCHEMA_VERSION ? [] : [`备份已从 ${migrated.schemaVersion} 迁移到 ${RISK_BACKUP_SCHEMA_VERSION}`],
  };
}

export function restoreRiskBackup(preview: BackupPreview, mode: "merge" | "overwrite", repository: PortfolioRepository, journal: LocalRiskJournalRepository): void {
  const backup = preview.backup;
  if (mode === "overwrite") repository.replaceTransactions(backup.transactions);
  else repository.appendTransactions(backup.transactions);
  if (mode === "overwrite") repository.saveBrokerPositions(backup.settings.brokerPositions);
  else {
    const current = repository.getBrokerPositions();
    const ids = new Set(current.map((item) => item.instrumentId));
    repository.saveBrokerPositions([...current, ...backup.settings.brokerPositions.filter((item) => !ids.has(item.instrumentId))]);
  }
  repository.setMarketMode(backup.settings.marketProviderMode);
  journal.restore({ reviews: backup.reviews, reviewFeedback: backup.reviewFeedback, memoryCandidates: backup.memoryCandidates, operations: backup.operations }, mode);
}

export function migrateBackup(value: unknown): RiskBackup {
  if (!isObject(value)) throw new Error("备份根节点必须是 JSON 对象。");
  if (value.schemaVersion !== RISK_BACKUP_SCHEMA_VERSION) throw new Error(`不支持的备份版本：${String(value.schemaVersion ?? "missing")}。`);
  if (!Array.isArray(value.transactions) || !value.transactions.every(isTransaction)) throw new Error("备份中的 transactions 无效。");
  if (!Array.isArray(value.tradePlans) || !Array.isArray(value.instrumentMetadata) || !isRiskRules(value.riskRules)) throw new Error("备份中的规则或证券元数据无效。");
  if (!Array.isArray(value.reviews) || !Array.isArray(value.reviewFeedback) || !Array.isArray(value.memoryCandidates)) throw new Error("备份中的复盘存档无效。");
  if (!isObject(value.settings) || !["mock", "api"].includes(String(value.settings.marketProviderMode)) || !Array.isArray(value.settings.brokerPositions)) throw new Error("备份中的 settings 无效。");
  if (!isObject(value.operations)) throw new Error("备份中的 diagnostics 状态无效。");
  return {
    schemaVersion: value.schemaVersion,
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
    transactions: value.transactions as Transaction[],
    tradePlans: value.tradePlans as TradePlan[],
    riskRules: value.riskRules,
    instrumentMetadata: value.instrumentMetadata as Instrument[],
    reviews: value.reviews as RiskBackup["reviews"],
    reviewFeedback: value.reviewFeedback as RiskBackup["reviewFeedback"],
    memoryCandidates: value.memoryCandidates as RiskBackup["memoryCandidates"],
    settings: { marketProviderMode: value.settings.marketProviderMode as "mock" | "api", brokerPositions: value.settings.brokerPositions as RiskBackup["settings"]["brokerPositions"] },
    operations: {
      completedDates: Array.isArray(value.operations.completedDates) ? value.operations.completedDates.filter((item): item is string => typeof item === "string") : [],
      market: value.operations.market as RiskBackup["operations"]["market"],
      portfolio: value.operations.portfolio as RiskBackup["operations"]["portfolio"],
      llm: value.operations.llm as RiskBackup["operations"]["llm"],
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isTransaction(value: unknown): value is Transaction { return isObject(value) && typeof value.id === "string" && typeof value.account === "string" && typeof value.type === "string" && typeof value.executedAt === "string" && typeof value.fingerprint === "string"; }
function isRiskRules(value: unknown): value is RiskRules { return isObject(value) && [value.maxSinglePosition, value.maxThemeConcentration, value.maxEffectiveExposure, value.quoteStaleSeconds].every((item) => typeof item === "number" && Number.isFinite(item)); }
function countIdConflicts<T extends { id: string }>(current: T[], incoming: T[]): number { const ids = new Set(current.map((item) => item.id)); return incoming.filter((item) => ids.has(item.id)).length; }
