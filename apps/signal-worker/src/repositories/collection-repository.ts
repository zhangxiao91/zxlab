import type {
  CandidateEditorialDecision,
  CandidateListItem,
  CandidateListResponse,
  CandidateSignal,
  CollectionRunDetail,
  CollectionRunSummary,
  CollectionSourceRunSummary,
  SignalCategory,
  SignalSourceType,
} from "@zxlab/signal-schema";
import type { SignalSourceConfig } from "../config/sources";
import { SignalError } from "../lib/errors";

interface CandidateRow {
  id: string; source_id: string; source_name: string; external_id: string; source_type: SignalSourceType;
  category_hint: SignalCategory; title: string; url: string; canonical_url: string; summary: string | null;
  content_text: string | null; author_json: string | null; published_at: string | null; updated_at: string | null;
  fetched_at: string; tags_json: string; language: string | null; content_hash: string; metadata_json: string;
  collection_run_id: string; status: CandidateSignal["status"]; duplicate_of: string | null;
  dedup_reason: CandidateSignal["dedupReason"] | null; editorial_decision: CandidateEditorialDecision["decision"] | null;
  editorial_category: SignalCategory | null; relevance: number | null; novelty: number | null; actionability: number | null;
  source_quality: number | null; editorial_reason: string | null; related_memory_ids_json: string | null;
  merge_target_candidate_id: string | null;
}

interface RunRow {
  id: string; status: CollectionRunSummary["status"]; trigger_type: CollectionRunSummary["triggerType"];
  started_at: string; completed_at: string | null; source_count: number; success_source_count: number;
  failed_source_count: number; fetched_count: number; inserted_count: number; duplicate_count: number; error_summary: string | null;
}

interface SourceRunRow {
  id: string; collection_run_id: string; source_id: string; source_name: string | null;
  status: CollectionSourceRunSummary["status"]; started_at: string; completed_at: string | null;
  fetched_count: number; inserted_count: number; duplicate_count: number; error_code: string | null; error_message: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function candidate(row: CandidateRow, includeContent = true): CandidateSignal {
  return {
    id: row.id,
    source: { sourceId: row.source_id, sourceName: row.source_name, sourceType: row.source_type, externalId: row.external_id },
    categoryHint: row.category_hint,
    title: row.title,
    url: row.url,
    canonicalUrl: row.canonical_url,
    summary: row.summary ?? undefined,
    contentText: includeContent ? row.content_text ?? undefined : undefined,
    author: parseJson(row.author_json, undefined),
    publishedAt: row.published_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    fetchedAt: row.fetched_at,
    tags: parseJson(row.tags_json, []),
    language: row.language ?? undefined,
    contentHash: row.content_hash,
    metadata: parseJson(row.metadata_json, {}),
    collectionRunId: row.collection_run_id,
    status: row.status,
    duplicateOf: row.duplicate_of ?? undefined,
    dedupReason: row.dedup_reason ?? undefined,
  };
}

function decision(row: CandidateRow): CandidateEditorialDecision | undefined {
  if (!row.editorial_decision || !row.editorial_category || row.relevance === null || row.novelty === null
    || row.actionability === null || row.source_quality === null || !row.editorial_reason) return undefined;
  return {
    candidateId: row.id,
    decision: row.editorial_decision,
    category: row.editorial_category,
    relevance: row.relevance,
    novelty: row.novelty,
    actionability: row.actionability,
    sourceQuality: row.source_quality,
    reason: row.editorial_reason,
    relatedMemoryIds: parseJson(row.related_memory_ids_json, []),
    mergeTargetCandidateId: row.merge_target_candidate_id ?? undefined,
  };
}

function run(row: RunRow): CollectionRunSummary {
  return { id: row.id, status: row.status, triggerType: row.trigger_type, startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined, sourceCount: row.source_count, successSourceCount: row.success_source_count,
    failedSourceCount: row.failed_source_count, fetchedCount: row.fetched_count, insertedCount: row.inserted_count,
    duplicateCount: row.duplicate_count, errorSummary: row.error_summary ?? undefined };
}

export class CollectionRepository {
  constructor(private readonly db: D1Database) {}

  async syncSources(sources: readonly SignalSourceConfig[], now: string): Promise<void> {
    await this.db.batch(sources.map((source) => this.db.prepare(`INSERT INTO signal_sources
      (id, name, type, enabled, category_hint, priority, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, enabled=excluded.enabled,
        category_hint=excluded.category_hint, priority=excluded.priority, config_json=excluded.config_json, updated_at=excluded.updated_at`)
      .bind(source.id, source.name, source.type, source.enabled ? 1 : 0, source.categoryHint, source.priority,
        JSON.stringify(source), now, now)));
  }

  async createRun(id: string, triggerType: CollectionRunSummary["triggerType"], sourceCount: number, startedAt: string): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO collection_runs
      (id, status, trigger_type, started_at, source_count) VALUES (?, 'running', ?, ?, ?)`)
      .bind(id, triggerType, startedAt, sourceCount).run();
  }

  async startSourceRun(id: string, runId: string, sourceId: string, startedAt: string): Promise<void> {
    await this.db.prepare(`INSERT INTO collection_source_runs
      (id, collection_run_id, source_id, status, started_at) VALUES (?, ?, ?, 'running', ?)
      ON CONFLICT(collection_run_id, source_id) DO UPDATE SET status='running', started_at=excluded.started_at,
        completed_at=NULL, fetched_count=0, inserted_count=0, duplicate_count=0, error_code=NULL, error_message=NULL`)
      .bind(id, runId, sourceId, startedAt).run();
  }

  async completeSourceRun(id: string, counts: { fetched: number; inserted: number; duplicates: number }): Promise<void> {
    await this.db.prepare(`UPDATE collection_source_runs SET status='succeeded', completed_at=?, fetched_count=?, inserted_count=?, duplicate_count=? WHERE id=?`)
      .bind(new Date().toISOString(), counts.fetched, counts.inserted, counts.duplicates, id).run();
  }

  async failSourceRun(id: string, code: string, message: string): Promise<void> {
    await this.db.prepare(`UPDATE collection_source_runs SET status='failed', completed_at=?, error_code=?, error_message=? WHERE id=?`)
      .bind(new Date().toISOString(), code, message.slice(0, 500), id).run();
  }

  async persistCandidate(value: CandidateSignal, dryRun = false): Promise<{ inserted: boolean; duplicate: boolean; candidate: CandidateSignal }> {
    const existing = await this.db.prepare(`${this.candidateSelect()} WHERE c.source_id=? AND c.external_id=? LIMIT 1`)
      .bind(value.source.sourceId, value.source.externalId).first<CandidateRow>();
    if (existing) {
      const current = candidate(existing);
      if (!dryRun) await this.db.prepare(`UPDATE candidate_signals SET title=?, url=?, canonical_url=?, summary=?, content_text=?, author_json=?,
        published_at=?, updated_at=?, fetched_at=?, tags_json=?, language=?, content_hash=?, metadata_json=?, collection_run_id=?, last_seen_at=? WHERE id=?`)
        .bind(value.title, value.url, value.canonicalUrl, value.summary ?? null, value.contentText ?? null,
          value.author ? JSON.stringify(value.author) : null, value.publishedAt ?? null, value.updatedAt ?? null, value.fetchedAt,
          JSON.stringify(value.tags), value.language ?? null, value.contentHash, JSON.stringify(value.metadata), value.collectionRunId,
          value.fetchedAt, existing.id).run();
      return { inserted: false, duplicate: true, candidate: { ...value, id: current.id, status: current.status } };
    }
    const duplicate = await this.db.prepare(`${this.candidateSelect()} WHERE c.canonical_url=? OR c.content_hash=? ORDER BY c.created_at LIMIT 1`)
      .bind(value.canonicalUrl, value.contentHash).first<CandidateRow>();
    const dedupReason = duplicate ? duplicate.canonical_url === value.canonicalUrl ? "canonical-url" as const : "content-hash" as const : undefined;
    const stored: CandidateSignal = duplicate
      ? { ...value, status: "duplicate", duplicateOf: duplicate.id, dedupReason }
      : { ...value, status: "eligible" };
    if (dryRun) return { inserted: false, duplicate: Boolean(duplicate), candidate: stored };
    {
      try {
        await this.db.prepare(`INSERT INTO candidate_signals
          (id, source_id, external_id, source_type, category_hint, title, url, canonical_url, summary, content_text,
           author_json, published_at, updated_at, fetched_at, tags_json, language, content_hash, metadata_json,
           collection_run_id, status, duplicate_of, dedup_reason, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(stored.id, stored.source.sourceId, stored.source.externalId, stored.source.sourceType, stored.categoryHint,
            stored.title, stored.url, stored.canonicalUrl, stored.summary ?? null, stored.contentText ?? null,
            stored.author ? JSON.stringify(stored.author) : null, stored.publishedAt ?? null, stored.updatedAt ?? null,
            stored.fetchedAt, JSON.stringify(stored.tags), stored.language ?? null, stored.contentHash, JSON.stringify(stored.metadata),
            stored.collectionRunId, stored.status, stored.duplicateOf ?? null, stored.dedupReason ?? null, stored.fetchedAt, stored.fetchedAt).run();
      } catch (cause) { throw new SignalError("CANDIDATE_PERSIST_FAILED", "Candidate could not be persisted", 500, cause); }
    }
    return { inserted: true, duplicate: Boolean(duplicate), candidate: stored };
  }

  async finalizeRun(id: string, counts: { successSources: number; failedSources: number; fetched: number; inserted: number; duplicates: number; errors: string[] }): Promise<CollectionRunSummary> {
    const status = counts.successSources === 0 ? "failed" : counts.failedSources > 0 ? "partial" : "succeeded";
    await this.db.prepare(`UPDATE collection_runs SET status=?, completed_at=?, success_source_count=?, failed_source_count=?,
      fetched_count=?, inserted_count=?, duplicate_count=?, error_summary=? WHERE id=?`)
      .bind(status, new Date().toISOString(), counts.successSources, counts.failedSources, counts.fetched, counts.inserted,
        counts.duplicates, counts.errors.length ? counts.errors.join("; ").slice(0, 1_000) : null, id).run();
    return this.getRun(id);
  }

  async latestRuns(limit = 10): Promise<CollectionRunSummary[]> {
    const result = await this.db.prepare("SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT ?").bind(limit).all<RunRow>();
    return result.results.map(run);
  }

  async getRun(id: string): Promise<CollectionRunDetail> {
    const row = await this.db.prepare("SELECT * FROM collection_runs WHERE id=?").bind(id).first<RunRow>();
    if (!row) throw new SignalError("COLLECTION_RUN_NOT_FOUND", "Collection run not found", 404);
    const sources = await this.db.prepare(`SELECT csr.*, ss.name AS source_name FROM collection_source_runs csr
      LEFT JOIN signal_sources ss ON ss.id=csr.source_id WHERE collection_run_id=? ORDER BY started_at`).bind(id).all<SourceRunRow>();
    return { ...run(row), sources: sources.results.map((source) => ({ id: source.id, collectionRunId: source.collection_run_id,
      sourceId: source.source_id, sourceName: source.source_name ?? undefined, status: source.status, startedAt: source.started_at,
      completedAt: source.completed_at ?? undefined, fetchedCount: source.fetched_count, insertedCount: source.inserted_count,
      duplicateCount: source.duplicate_count, errorCode: source.error_code ?? undefined, errorMessage: source.error_message ?? undefined })) };
  }

  async getCandidate(id: string): Promise<CandidateListItem> {
    const row = await this.db.prepare(`${this.candidateSelect()} WHERE c.id=?`).bind(id).first<CandidateRow>();
    if (!row) throw new SignalError("SOURCE_NOT_FOUND", "Candidate not found", 404);
    return { ...candidate(row), editorialDecision: decision(row) };
  }

  async listCandidates(filters: {
    sourceId?: string; sourceType?: SignalSourceType; category?: SignalCategory; status?: CandidateSignal["status"];
    collectionRunId?: string; since?: string; keyword?: string; limit?: number; cursor?: string;
  }): Promise<CandidateListResponse> {
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    const add = (clause: string, value: unknown) => { clauses.push(clause); bindings.push(value); };
    if (filters.sourceId) add("c.source_id=?", filters.sourceId);
    if (filters.sourceType) add("c.source_type=?", filters.sourceType);
    if (filters.category) add("c.category_hint=?", filters.category);
    if (filters.status) add("c.status=?", filters.status);
    if (filters.collectionRunId) add("c.collection_run_id=?", filters.collectionRunId);
    if (filters.since) add("COALESCE(c.published_at,c.fetched_at)>=?", filters.since);
    if (filters.keyword) { clauses.push("(c.title LIKE ? OR c.summary LIKE ?)"); bindings.push(`%${filters.keyword}%`, `%${filters.keyword}%`); }
    if (filters.cursor) {
      const [fetchedAt, id] = filters.cursor.split("|");
      if (fetchedAt && id) { clauses.push("(c.fetched_at < ? OR (c.fetched_at = ? AND c.id < ?))"); bindings.push(fetchedAt, fetchedAt, id); }
    }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    bindings.push(limit + 1);
    const result = await this.db.prepare(`${this.candidateSelect()} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY c.fetched_at DESC, c.id DESC LIMIT ?`).bind(...bindings).all<CandidateRow>();
    const page = result.results.slice(0, limit);
    const last = page.at(-1);
    return {
      candidates: page.map((row) => ({ ...candidate(row, false), editorialDecision: decision(row) })),
      nextCursor: result.results.length > limit && last ? `${last.fetched_at}|${last.id}` : undefined,
    };
  }

  async candidatesForBriefing(input: { collectionRunId?: string; since?: string; until?: string; category?: SignalCategory; maxCandidates: number }): Promise<CandidateSignal[]> {
    const clauses = ["c.status IN ('new','eligible')", "c.duplicate_of IS NULL"];
    const bindings: unknown[] = [];
    if (input.collectionRunId) { clauses.push("c.collection_run_id=?"); bindings.push(input.collectionRunId); }
    if (input.since) { clauses.push("COALESCE(c.published_at,c.fetched_at)>=?"); bindings.push(input.since); }
    if (input.until) { clauses.push("COALESCE(c.published_at,c.fetched_at)<=?"); bindings.push(input.until); }
    if (input.category) { clauses.push("c.category_hint=?"); bindings.push(input.category); }
    bindings.push(input.maxCandidates);
    const result = await this.db.prepare(`${this.candidateSelect()} WHERE ${clauses.join(" AND ")}
      ORDER BY ss.priority DESC, COALESCE(c.published_at,c.fetched_at) DESC LIMIT ?`).bind(...bindings).all<CandidateRow>();
    return result.results.map((row) => candidate(row));
  }

  async saveEditorialDecisions(decisions: CandidateEditorialDecision[]): Promise<void> {
    if (!decisions.length) return;
    await this.db.batch(decisions.map((value) => this.db.prepare(`UPDATE candidate_signals SET editorial_decision=?, editorial_category=?,
      relevance=?, novelty=?, actionability=?, source_quality=?, editorial_reason=?, related_memory_ids_json=?,
      merge_target_candidate_id=?, status=? WHERE id=?`)
      .bind(value.decision, value.category, value.relevance, value.novelty, value.actionability, value.sourceQuality,
        value.reason, JSON.stringify(value.relatedMemoryIds), value.mergeTargetCandidateId ?? null,
        value.decision === "drop" || value.decision === "merge" ? "filtered" : "eligible", value.candidateId)));
  }

  private candidateSelect(): string {
    return `SELECT c.*, ss.name AS source_name FROM candidate_signals c JOIN signal_sources ss ON ss.id=c.source_id`;
  }
}
