import {
  PORTFOLIO_SNAPSHOT_MAX_AGE_MS,
  PORTFOLIO_SNAPSHOT_MAX_POSITIONS,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
  type PortfolioSnapshotUpload,
} from "@zxlab/market-agent-schema";
import { calculateCash, type PortfolioRepository } from "../risk/ledger";
import { RISK_RULE_VERSION } from "../risk/workspace";

const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SNAPSHOT_ID = /^[a-zA-Z0-9._:-]{1,112}$/;
const INSTRUMENT_ID = /^(SSE|SZSE):\d{6}$/;
const UNRESOLVED_WARNING = /(?:未解析|无法识别(?:证券|代码|交易所|标的)|unresolved)/i;

export interface LocalPortfolioSnapshotPreview {
  sourceSnapshotId: string | null;
  sourceSnapshotAt: string | null;
  positionCount: number;
  cash: number | null;
  upload: PortfolioSnapshotUpload | null;
  issues: string[];
}

/**
 * Builds the smallest Agent-safe representation from a user-confirmed local
 * broker snapshot. The source document, raw rows, account name and warnings
 * never cross this boundary.
 */
export function previewLocalPortfolioSnapshot(
  repository: PortfolioRepository,
  now = Date.now(),
): LocalPortfolioSnapshotPreview {
  const snapshot = repository.getBrokerSnapshot();
  if (!snapshot) {
    return {
      sourceSnapshotId: null,
      sourceSnapshotAt: null,
      positionCount: 0,
      cash: null,
      upload: null,
      issues: ["请先在持仓风险台确认一份券商持仓快照。"],
    };
  }

  const issues: string[] = [];
  const sourceSnapshotAtMs = Date.parse(snapshot.snapshotAt);
  const cash = calculateCash(repository.listTransactions());
  const sourceRevision = `risk:${snapshot.id}`;
  const positions = snapshot.positions.map((position) => ({
    instrumentId: position.instrumentId.trim().toUpperCase(),
    quantity: position.quantity,
    averageCost: position.averageCost,
  }));

  if (!Number.isFinite(sourceSnapshotAtMs)) {
    issues.push("已确认券商快照缺少有效时间，不能同步。");
  } else {
    if (sourceSnapshotAtMs > now + FUTURE_CLOCK_SKEW_MS) {
      issues.push("已确认券商快照的时间在当前时间之后，不能同步。");
    }
    if (now - sourceSnapshotAtMs > PORTFOLIO_SNAPSHOT_MAX_AGE_MS) {
      issues.push("已确认券商快照超过 36 小时，请重新导入并确认。" );
    }
  }
  if (!SNAPSHOT_ID.test(snapshot.id)) {
    issues.push("已确认券商快照的版本标识无效，不能同步。");
  }
  if (!positions.length || positions.length > PORTFOLIO_SNAPSHOT_MAX_POSITIONS) {
    issues.push(`已确认券商快照必须包含 1 至 ${PORTFOLIO_SNAPSHOT_MAX_POSITIONS} 个持仓。`);
  }
  const seen = new Set<string>();
  positions.forEach((position, index) => {
    if (!INSTRUMENT_ID.test(position.instrumentId) || seen.has(position.instrumentId)) {
      issues.push(`第 ${index + 1} 个持仓的证券代码无效或重复。`);
    }
    seen.add(position.instrumentId);
    if (!Number.isFinite(position.quantity) || position.quantity <= 0) {
      issues.push(`第 ${index + 1} 个持仓缺少有效数量。`);
    }
    if (position.averageCost === null || !Number.isFinite(position.averageCost) || position.averageCost < 0) {
      issues.push(`第 ${index + 1} 个持仓缺少有效平均成本。`);
    }
  });
  const unresolvedCount = snapshot.rawDraftWarnings.filter((warning) => UNRESOLVED_WARNING.test(warning)).length;
  if (unresolvedCount) {
    issues.push(`已确认券商快照仍有 ${unresolvedCount} 条未解析持仓，请先处理后再同步。`);
  }
  if (!Number.isFinite(cash)) {
    issues.push("本地账本无法汇总有效现金，不能同步。");
  }

  if (issues.length || !Number.isFinite(sourceSnapshotAtMs) || !Number.isFinite(cash)) {
    return {
      sourceSnapshotId: snapshot.id,
      sourceSnapshotAt: Number.isFinite(sourceSnapshotAtMs) ? new Date(sourceSnapshotAtMs).toISOString() : null,
      positionCount: positions.length,
      cash: Number.isFinite(cash) ? cash : null,
      upload: null,
      issues,
    };
  }

  const effectiveAt = new Date(now).toISOString();
  const expiresAt = new Date(sourceSnapshotAtMs + PORTFOLIO_SNAPSHOT_MAX_AGE_MS).toISOString();
  return {
    sourceSnapshotId: snapshot.id,
    sourceSnapshotAt: new Date(sourceSnapshotAtMs).toISOString(),
    positionCount: positions.length,
    cash,
    upload: {
      schemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
      sourceRevision,
      calculatedAt: new Date(sourceSnapshotAtMs).toISOString(),
      effectiveAt,
      expiresAt,
      positions: positions as PortfolioSnapshotUpload["positions"],
      cash,
      rulesVersion: RISK_RULE_VERSION,
    },
    issues: [],
  };
}
