export interface WatchlistItemInput { instrumentId: string; reason?: string; }
export interface MarketAgentProfile { profileId: string; watchlistRevision: string | null; bootstrap: "required" | "complete"; }

export class D1ProfileRepository {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async resolve(ownerSubjectHash: string): Promise<MarketAgentProfile> {
    const existing = await this.db.prepare("SELECT id, watchlist_revision FROM market_agent_profiles WHERE owner_subject_hash = ?").bind(ownerSubjectHash).first<{ id: string; watchlist_revision: string | null }>();
    if (existing) return profile(existing.id, existing.watchlist_revision);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.db.prepare("INSERT INTO market_agent_profiles (id, owner_subject_hash, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_subject_hash) DO NOTHING").bind(id, ownerSubjectHash, now, now).run();
    const created = await this.db.prepare("SELECT id, watchlist_revision FROM market_agent_profiles WHERE owner_subject_hash = ?").bind(ownerSubjectHash).first<{ id: string; watchlist_revision: string | null }>();
    if (!created) throw new Error("PROFILE_RESOLUTION_FAILED");
    return profile(created.id, created.watchlist_revision);
  }

  async getWatchlist(profileId: string): Promise<{ revision: string; items: WatchlistItemInput[] } | null> {
    const current = await this.db.prepare("SELECT watchlist_revision FROM market_agent_profiles WHERE id = ?").bind(profileId).first<{ watchlist_revision: string | null }>();
    if (!current?.watchlist_revision) return null;
    const row = await this.db.prepare("SELECT items_json FROM market_watchlists WHERE profile_id = ? AND revision = ?").bind(profileId, current.watchlist_revision).first<{ items_json: string }>();
    return row ? { revision: current.watchlist_revision, items: JSON.parse(row.items_json) as WatchlistItemInput[] } : null;
  }

  async listBootstrappedProfileIds(limit = 500): Promise<string[]> { const result = await this.db.prepare("SELECT id FROM market_agent_profiles WHERE watchlist_revision IS NOT NULL ORDER BY id LIMIT ?").bind(limit).all<{ id: string }>(); return result.results.map((row) => row.id); }

  async syncWatchlist(profileId: string, revision: string, items: WatchlistItemInput[]): Promise<MarketAgentProfile> {
    const normalized = normalizeWatchlist(items);
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare("INSERT INTO market_watchlists (profile_id, revision, items_json, confirmed_at) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, revision) DO UPDATE SET items_json = excluded.items_json, confirmed_at = excluded.confirmed_at").bind(profileId, revision, JSON.stringify(normalized), now),
      this.db.prepare("UPDATE market_agent_profiles SET watchlist_revision = ?, revision = revision + 1, updated_at = ? WHERE id = ?").bind(revision, now, profileId),
    ]);
    return profile(profileId, revision);
  }
}

export function normalizeWatchlist(value: unknown): WatchlistItemInput[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("INVALID_WATCHLIST");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_WATCHLIST");
    const item = entry as Record<string, unknown>;
    const instrumentId = typeof item.instrumentId === "string" ? item.instrumentId.trim().toUpperCase() : "";
    const reason = typeof item.reason === "string" ? item.reason.trim() : undefined;
    if (!/^(SSE|SZSE):\d{6}$/.test(instrumentId) || seen.has(instrumentId) || (reason?.length ?? 0) > 500) throw new Error("INVALID_WATCHLIST");
    seen.add(instrumentId);
    return reason ? { instrumentId, reason } : { instrumentId };
  });
}

function profile(profileId: string, watchlistRevision: string | null): MarketAgentProfile {
  return { profileId, watchlistRevision, bootstrap: watchlistRevision ? "complete" : "required" };
}
