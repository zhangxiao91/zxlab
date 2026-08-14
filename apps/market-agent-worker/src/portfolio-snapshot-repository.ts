import {
  calculatePortfolioSnapshotFingerprint,
  type PortfolioSnapshot,
  type PortfolioSnapshotPosition,
  type PortfolioSnapshotUpload,
} from "@zxlab/market-agent-schema";

export type PortfolioPurgeScope = "all" | "expired";

export interface PortfolioSnapshotControlState {
  snapshot: PortfolioSnapshot | null;
  historicalSnapshotCount: number;
  linkedRunCount: number;
  expiredSnapshotCount: number;
  expiredLinkedRunCount: number;
}

export class D1PortfolioSnapshotRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async sync(profileId: string, upload: PortfolioSnapshotUpload): Promise<PortfolioSnapshot> {
    const fingerprint = await calculatePortfolioSnapshotFingerprint(upload);
    const existing = await this.db.prepare("SELECT * FROM portfolio_snapshots WHERE profile_id = ? AND fingerprint = ?").bind(profileId, fingerprint).first<Record<string, unknown>>();
    const now = new Date().toISOString();
    const id = existing ? String(existing.id) : crypto.randomUUID();
    const warnings = ["该快照来自浏览器本地 Risk 工作台，未与券商服务端对账。"];
    const statements: D1PreparedStatement[] = existing
      ? [this.db.prepare("UPDATE portfolio_snapshots SET stopped_at = NULL WHERE id = ? AND profile_id = ?").bind(id, profileId)]
      : [this.db.prepare("INSERT INTO portfolio_snapshots (id, profile_id, schema_version, source_revision, calculated_at, effective_at, expires_at, positions_json, cash, rules_version, reliable, warnings_json, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, profileId, upload.schemaVersion, upload.sourceRevision, upload.calculatedAt, upload.effectiveAt, upload.expiresAt, JSON.stringify(upload.positions), upload.cash, upload.rulesVersion, 1, JSON.stringify(warnings), fingerprint, now)];
    statements.push(this.db.prepare("UPDATE market_agent_profiles SET current_portfolio_snapshot_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(id, now, profileId));
    await this.db.batch(statements);
    const snapshot = await this.getForProfile(profileId, id);
    if (!snapshot) throw new Error("PORTFOLIO_SNAPSHOT_SYNC_FAILED");
    return snapshot;
  }

  async getCurrent(profileId: string, now = new Date().toISOString()): Promise<PortfolioSnapshot | null> {
    const row = await this.db.prepare("SELECT snapshots.* FROM market_agent_profiles AS profiles INNER JOIN portfolio_snapshots AS snapshots ON snapshots.id = profiles.current_portfolio_snapshot_id WHERE profiles.id = ? AND snapshots.stopped_at IS NULL AND snapshots.expires_at > ?").bind(profileId, now).first<Record<string, unknown>>();
    return row ? rowToSnapshot(row) : null;
  }

  async getForProfile(profileId: string, snapshotId: string): Promise<PortfolioSnapshot | null> {
    const row = await this.db.prepare("SELECT * FROM portfolio_snapshots WHERE profile_id = ? AND id = ?").bind(profileId, snapshotId).first<Record<string, unknown>>();
    return row ? rowToSnapshot(row) : null;
  }

  async getUsableForProfile(profileId: string, snapshotId: string, now = new Date().toISOString()): Promise<PortfolioSnapshot | null> {
    const row = await this.db.prepare("SELECT * FROM portfolio_snapshots WHERE profile_id = ? AND id = ? AND stopped_at IS NULL AND expires_at > ?").bind(profileId, snapshotId, now).first<Record<string, unknown>>();
    return row ? rowToSnapshot(row) : null;
  }

  async controlState(profileId: string): Promise<PortfolioSnapshotControlState> {
    const now = new Date().toISOString();
    const [snapshot, history, runs, expiredSnapshots, expiredRuns] = await Promise.all([
      this.getCurrent(profileId, now),
      this.db.prepare("SELECT COUNT(*) AS count FROM portfolio_snapshots WHERE profile_id = ?").bind(profileId).first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE profile_id = ? AND portfolio_snapshot_id IS NOT NULL").bind(profileId).first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) AS count FROM portfolio_snapshots WHERE profile_id = ? AND expires_at <= ?").bind(profileId, now).first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs AS runs INNER JOIN portfolio_snapshots AS snapshots ON snapshots.id = runs.portfolio_snapshot_id WHERE runs.profile_id = ? AND snapshots.profile_id = ? AND snapshots.expires_at <= ?").bind(profileId, profileId, now).first<{ count: number }>(),
    ]);
    return {
      snapshot,
      historicalSnapshotCount: Number(history?.count ?? 0),
      linkedRunCount: Number(runs?.count ?? 0),
      expiredSnapshotCount: Number(expiredSnapshots?.count ?? 0),
      expiredLinkedRunCount: Number(expiredRuns?.count ?? 0),
    };
  }

  async stopUse(profileId: string, requestedSnapshotId?: string): Promise<{ stopped: boolean; detachedRunCount: number }> {
    const snapshot = await this.getCurrent(profileId);
    if (!snapshot || (requestedSnapshotId && requestedSnapshotId !== snapshot.id)) return { stopped: false, detachedRunCount: 0 };
    const pending = await this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE profile_id = ? AND portfolio_snapshot_id = ? AND status IN ('queued', 'retry_wait')").bind(profileId, snapshot.id).first<{ count: number }>();
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare("UPDATE market_agent_profiles SET current_portfolio_snapshot_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND current_portfolio_snapshot_id = ?").bind(now, profileId, snapshot.id),
      this.db.prepare("UPDATE portfolio_snapshots SET stopped_at = COALESCE(stopped_at, ?) WHERE id = ? AND profile_id = ?").bind(now, snapshot.id, profileId),
      this.db.prepare("UPDATE agent_runs SET portfolio_snapshot_id = NULL, updated_at = ? WHERE profile_id = ? AND portfolio_snapshot_id = ? AND status IN ('queued', 'retry_wait')").bind(now, profileId, snapshot.id),
    ]);
    return { stopped: true, detachedRunCount: Number(pending?.count ?? 0) };
  }

  async purgeHistory(profileId: string, scope: PortfolioPurgeScope, now = new Date().toISOString()): Promise<{ snapshots: number; runs: number }> {
    const filter = scope === "expired" ? "profile_id = ? AND expires_at <= ?" : "profile_id = ?";
    const filterValues: unknown[] = scope === "expired" ? [profileId, now] : [profileId];
    const snapshots = await this.db.prepare(`SELECT id, fingerprint FROM portfolio_snapshots WHERE ${filter}`).bind(...filterValues).all<{ id: string; fingerprint: string }>();
    const ids = snapshots.results.map((row) => row.id);
    if (!ids.length) return { snapshots: 0, runs: 0 };

    const placeholders = ids.map(() => "?").join(", ");
    const runScope = `SELECT id FROM agent_runs WHERE profile_id = ? AND portfolio_snapshot_id IN (${placeholders})`;
    const runBindings: unknown[] = [profileId, ...ids];
    const runCounts = await this.db.prepare(`SELECT portfolio_snapshot_id, COUNT(*) AS count FROM agent_runs WHERE profile_id = ? AND portfolio_snapshot_id IN (${placeholders}) GROUP BY portfolio_snapshot_id`).bind(...runBindings).all<{ portfolio_snapshot_id: string; count: number }>();
    const countBySnapshot = new Map(runCounts.results.map((row) => [row.portfolio_snapshot_id, Number(row.count)]));
    const runTotal = [...countBySnapshot.values()].reduce((total, count) => total + count, 0);
    const statements: D1PreparedStatement[] = [
      ...snapshots.results.map((snapshot) => this.db.prepare("INSERT INTO portfolio_purge_tombstones (id, profile_id, snapshot_id, snapshot_fingerprint, purged_at, purged_run_count, scope) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), profileId, snapshot.id, snapshot.fingerprint, now, countBySnapshot.get(snapshot.id) ?? 0, scope)),
      this.db.prepare(`DELETE FROM agent_feedback WHERE profile_id = ? AND run_id IN (${runScope})`).bind(profileId, ...runBindings),
      this.db.prepare(`DELETE FROM market_events WHERE run_id IN (${runScope})`).bind(...runBindings),
      this.db.prepare(`DELETE FROM run_market_events WHERE run_id IN (${runScope})`).bind(...runBindings),
      this.db.prepare(`DELETE FROM run_market_snapshots WHERE run_id IN (${runScope})`).bind(...runBindings),
      this.db.prepare(`DELETE FROM run_dispatch_outbox WHERE run_id IN (${runScope})`).bind(...runBindings),
      this.db.prepare(`DELETE FROM dead_letter_records WHERE run_id IN (${runScope})`).bind(...runBindings),
      this.db.prepare(`DELETE FROM agent_runs WHERE profile_id = ? AND id IN (${runScope})`).bind(profileId, ...runBindings),
      this.db.prepare(`UPDATE market_agent_profiles SET current_portfolio_snapshot_id = CASE WHEN current_portfolio_snapshot_id IN (${placeholders}) THEN NULL ELSE current_portfolio_snapshot_id END, revision = revision + 1, updated_at = ? WHERE id = ?`).bind(...ids, now, profileId),
      this.db.prepare(`DELETE FROM portfolio_snapshots WHERE profile_id = ? AND id IN (${placeholders})`).bind(profileId, ...ids),
    ];
    await batchInChunks(this.db, statements);
    return { snapshots: ids.length, runs: runTotal };
  }
}

async function batchInChunks(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 80) await db.batch(statements.slice(index, index + 80));
}

function rowToSnapshot(row: Record<string, unknown>): PortfolioSnapshot {
  return {
    id: String(row.id),
    schemaVersion: "portfolio-snapshot.v1",
    sourceRevision: String(row.source_revision),
    calculatedAt: String(row.calculated_at),
    effectiveAt: String(row.effective_at),
    expiresAt: String(row.expires_at),
    positions: JSON.parse(String(row.positions_json)) as PortfolioSnapshotPosition[],
    cash: Number(row.cash),
    rulesVersion: String(row.rules_version),
    reliable: Number(row.reliable) === 1,
    warnings: JSON.parse(String(row.warnings_json)) as string[],
    fingerprint: String(row.fingerprint) as `sha256:${string}`,
    createdAt: String(row.created_at),
    stoppedAt: row.stopped_at ? String(row.stopped_at) : null,
  };
}
