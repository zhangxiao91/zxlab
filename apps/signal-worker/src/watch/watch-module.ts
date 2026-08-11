import type {
  BriefingCategory,
  BriefingItem,
  BriefingSource,
  CreateWatchRequest,
  DailyBriefing,
  WatchDossier,
  WatchObservation,
  WatchStatus,
} from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { storySimilarity } from "../services/story-context";

interface WatchRow {
  id: string;
  title: string;
  condition: string;
  category: BriefingCategory;
  status: WatchStatus;
  seed_briefing_id: string;
  seed_briefing_item_id: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface ObservationRow {
  id: string;
  watch_id: string;
  observation_type: WatchObservation["type"];
  briefing_id: string;
  briefing_item_id: string;
  title: string;
  summary: string;
  sources_json: string;
  observed_at: string;
}

interface SeedItemRow {
  id: string;
  briefing_id: string;
  title: string;
  category: BriefingCategory;
  summary: string;
}

interface ExistingWatchRow {
  id: string;
  status: WatchStatus;
}

interface SourceRow {
  id: string;
  title: string;
  url: string;
  publisher: string | null;
  published_at: string | null;
}

const MATCH_THRESHOLD = 0.42;
const MAX_ACTIVE_WATCHES = 100;
const OBSERVATION_BATCH_SIZE = 25;

function observationSources(value: string): BriefingSource[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as BriefingSource[] : [];
  } catch {
    return [];
  }
}

function observation(row: ObservationRow): WatchObservation {
  return {
    id: row.id,
    type: row.observation_type,
    briefingId: row.briefing_id,
    briefingItemId: row.briefing_item_id,
    title: row.title,
    summary: row.summary,
    sources: observationSources(row.sources_json),
    observedAt: row.observed_at,
  };
}

function dossier(row: WatchRow, observations: WatchObservation[]): WatchDossier {
  return {
    id: row.id,
    title: row.title,
    condition: row.condition,
    category: row.category,
    status: row.status,
    seedBriefingId: row.seed_briefing_id,
    seedBriefingItemId: row.seed_briefing_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
    observations,
  };
}

function itemSummary(item: BriefingItem): string {
  return item.lede ?? item.summary;
}

function matchScore(watch: Pick<WatchRow, "title" | "condition" | "category">, item: BriefingItem): number {
  if (watch.category !== item.category) return 0;
  const titleScore = storySimilarity(watch.title, item.title);
  const watchText = `${watch.title} ${watch.condition}`;
  const itemText = `${item.title} ${itemSummary(item)} ${item.whatChanged ?? ""} ${item.watchNext ?? ""}`;
  return Math.max(titleScore, storySimilarity(watchText, itemText));
}

function bestMatch(watch: WatchRow, items: BriefingItem[]): BriefingItem | undefined {
  let selected: BriefingItem | undefined;
  let selectedScore = MATCH_THRESHOLD;
  for (const item of items) {
    const score = matchScore(watch, item);
    if (score < MATCH_THRESHOLD || (selected && score <= selectedScore)) continue;
    selected = item;
    selectedScore = score;
  }
  return selected;
}

/**
 * Owns Watch lifecycle and deterministic briefing observation matching.
 * D1 is injected so callers and local tests exercise the same module seam.
 */
export class WatchModule {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<WatchDossier[]> {
    const rows = await this.db.prepare(`SELECT * FROM watch_dossiers
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, created_at DESC
      LIMIT 100`)
      .all<WatchRow>();
    if (!rows.results.length) return [];
    const placeholders = rows.results.map(() => "?").join(", ");
    const observed = await this.db.prepare(`SELECT * FROM watch_observations
      WHERE watch_id IN (${placeholders})
      ORDER BY CASE observation_type WHEN 'created' THEN 0 ELSE 1 END, observed_at, id`)
      .bind(...rows.results.map((row) => row.id)).all<ObservationRow>();
    const byWatch = new Map<string, WatchObservation[]>();
    for (const row of observed.results) {
      const entries = byWatch.get(row.watch_id) ?? [];
      entries.push(observation(row));
      byWatch.set(row.watch_id, entries);
    }
    return rows.results.map((row) => dossier(row, byWatch.get(row.id) ?? []));
  }

  async create(input: CreateWatchRequest): Promise<WatchDossier> {
    const condition = input.condition.trim();
    if (!condition) throw new SignalError("INVALID_REQUEST", "Watch condition is required", 400);
    const item = await this.db.prepare(`SELECT i.id, i.briefing_id, i.title, i.category,
      COALESCE(NULLIF(i.lede, ''), i.summary) summary
      FROM briefing_items i JOIN briefings b ON b.id = i.briefing_id
      WHERE i.id = ? AND i.briefing_id = ?
        AND b.data_origin = 'real' AND b.status IN ('ready', 'superseded')
      LIMIT 1`)
      .bind(input.briefingItemId, input.briefingId).first<SeedItemRow>();
    if (!item) throw new SignalError("ITEM_NOT_FOUND", "A real briefing item was not found", 404);
    const existing = await this.findBySeed(item.id, condition);
    if (existing?.status === "active") return this.get(existing.id);
    if (existing) return this.reactivate(existing.id);
    const sources = await this.itemSources(item.id);
    const now = new Date().toISOString();
    const watchId = crypto.randomUUID();
    try {
      const results = await this.db.batch([
        this.db.prepare(`INSERT INTO watch_dossiers
          (id, title, condition, category, status, seed_briefing_id, seed_briefing_item_id, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM watch_dossiers WHERE status = 'active') < ?
          ON CONFLICT(seed_briefing_item_id, condition) DO NOTHING`)
          .bind(watchId, item.title, condition, item.category, item.briefing_id, item.id, now, now, MAX_ACTIVE_WATCHES),
        this.db.prepare(`INSERT INTO watch_observations
          (id, watch_id, observation_type, briefing_id, briefing_item_id, title, summary, sources_json, observed_at)
          SELECT ?, ?, 'created', ?, ?, ?, ?, ?, ?
          FROM watch_dossiers WHERE id = ?`)
          .bind(crypto.randomUUID(), watchId, item.briefing_id, item.id, item.title, item.summary, JSON.stringify(sources), now, watchId),
      ]);
      if (results[0]?.meta.changes !== 1) {
        const concurrent = await this.findBySeed(item.id, condition);
        if (concurrent?.status === "active") return this.get(concurrent.id);
        if (concurrent) return this.reactivate(concurrent.id);
        throw new SignalError("RATE_LIMITED", `Signal supports at most ${MAX_ACTIVE_WATCHES} active Watches`, 429);
      }
    } catch (cause) {
      if (cause instanceof SignalError) throw cause;
      const concurrent = await this.findBySeed(item.id, condition);
      if (concurrent?.status === "active") return this.get(concurrent.id);
      if (concurrent) return this.reactivate(concurrent.id);
      throw new SignalError("DATABASE_WRITE_FAILED", "The Watch could not be persisted", 500, cause);
    }
    return this.get(watchId);
  }

  async resolve(id: string): Promise<WatchDossier> {
    const now = new Date().toISOString();
    await this.db.prepare(`UPDATE watch_dossiers SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`).bind(now, now, id).run();
    return this.get(id);
  }

  async observeBriefing(briefing: DailyBriefing): Promise<number> {
    if (briefing.status !== "ready" || briefing.dataOrigin !== "real") return 0;
    const active = await this.db.prepare(`SELECT * FROM watch_dossiers WHERE status = 'active'
      ORDER BY created_at, id LIMIT ?`).bind(MAX_ACTIVE_WATCHES + 1).all<WatchRow>();
    if (active.results.length > MAX_ACTIVE_WATCHES) {
      console.error(JSON.stringify({
        event: "signal.watch.active_limit_exceeded",
        limit: MAX_ACTIVE_WATCHES,
      }));
    }
    const matches = active.results.slice(0, MAX_ACTIVE_WATCHES).flatMap((watch) => {
      const item = bestMatch(watch, briefing.items);
      return item ? [{ watch, item }] : [];
    });
    let insertedCount = 0;
    for (let offset = 0; offset < matches.length; offset += OBSERVATION_BATCH_SIZE) {
      const batch = matches.slice(offset, offset + OBSERVATION_BATCH_SIZE);
      // D1 batch is the transaction seam: a retry always converges the
      // observation row and dossier timestamp, while resolved dossiers no-op.
      const statements = batch.flatMap(({ watch, item }) => {
        const observedAt = briefing.generatedAt;
        return [
          this.db.prepare(`INSERT OR IGNORE INTO watch_observations
            (id, watch_id, observation_type, briefing_id, briefing_item_id, title, summary, sources_json, observed_at)
            SELECT ?, ?, 'update', ?, ?, ?, ?, ?, ?
            FROM watch_dossiers w WHERE w.id = ? AND w.status = 'active'
              AND (
                EXISTS (SELECT 1 FROM watch_observations existing
                  WHERE existing.watch_id = w.id AND existing.briefing_item_id = ?)
                OR ? > COALESCE(
                  (SELECT MAX(observed_briefing.briefing_date)
                    FROM watch_observations observed
                    JOIN briefings observed_briefing ON observed_briefing.id = observed.briefing_id
                    WHERE observed.watch_id = w.id),
                  (SELECT seed_briefing.briefing_date FROM briefings seed_briefing WHERE seed_briefing.id = w.seed_briefing_id)
                )
              )`)
            .bind(crypto.randomUUID(), watch.id, briefing.id, item.id, item.title, itemSummary(item), JSON.stringify(item.sources), observedAt,
              watch.id, item.id, briefing.date),
          this.db.prepare(`UPDATE watch_dossiers
            SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
            WHERE id = ? AND status = 'active'
              AND EXISTS (SELECT 1 FROM watch_observations WHERE watch_id = ? AND briefing_item_id = ?)`)
            .bind(observedAt, observedAt, watch.id, watch.id, item.id),
        ];
      });
      const results = await this.db.batch(statements);
      for (let index = 0; index < results.length; index += 2) {
        insertedCount += results[index]?.meta.changes === 1 ? 1 : 0;
      }
    }
    return insertedCount;
  }

  private async get(id: string): Promise<WatchDossier> {
    const row = await this.db.prepare("SELECT * FROM watch_dossiers WHERE id = ? LIMIT 1").bind(id).first<WatchRow>();
    if (!row) throw new SignalError("WATCH_NOT_FOUND", "Watch not found", 404);
    const observed = await this.db.prepare(`SELECT * FROM watch_observations WHERE watch_id = ?
      ORDER BY CASE observation_type WHEN 'created' THEN 0 ELSE 1 END, observed_at, id`)
      .bind(id).all<ObservationRow>();
    return dossier(row, observed.results.map(observation));
  }

  private async reactivate(id: string): Promise<WatchDossier> {
    const now = new Date().toISOString();
    try {
      const result = await this.db.prepare(`UPDATE watch_dossiers
        SET status = 'active', resolved_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'resolved'
          AND (SELECT COUNT(*) FROM watch_dossiers WHERE status = 'active') < ?`)
        .bind(now, id, MAX_ACTIVE_WATCHES).run();
      if (result.meta.changes === 1) return this.get(id);
      const current = await this.get(id);
      if (current.status === "active") return current;
      throw new SignalError("RATE_LIMITED", `Signal supports at most ${MAX_ACTIVE_WATCHES} active Watches`, 429);
    } catch (cause) {
      if (cause instanceof SignalError) throw cause;
      throw new SignalError("DATABASE_WRITE_FAILED", "The Watch could not be reactivated", 500, cause);
    }
  }

  private async findBySeed(itemId: string, condition: string): Promise<ExistingWatchRow | null> {
    return this.db.prepare(`SELECT id, status FROM watch_dossiers
      WHERE seed_briefing_item_id = ? AND condition = ? LIMIT 1`).bind(itemId, condition).first<ExistingWatchRow>();
  }

  private async itemSources(itemId: string): Promise<BriefingSource[]> {
    const result = await this.db.prepare("SELECT id, title, url, publisher, published_at FROM briefing_sources WHERE item_id = ? ORDER BY published_at DESC, id")
      .bind(itemId).all<SourceRow>();
    return result.results.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      publisher: source.publisher ?? undefined,
      publishedAt: source.published_at ?? undefined,
    }));
  }
}
