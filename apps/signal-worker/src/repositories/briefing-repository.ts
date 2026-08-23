import type { BriefingItem, CandidateSignal, DailyBriefing, GeneratedBriefingDraft, LongTermThread } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import type { PriorBriefingContext } from "../services/story-context";
import { SIGNAL_SOURCE_POLICY_VERSION } from "../services/source-policy";

interface BriefingRow {
  id: string; run_id: string; briefing_date: string; title: string; summary: string; status: string;
  data_origin: "fixture" | "real"; generated_at: string; prompt_version: string; model: string;
  generation_mode: DailyBriefing["generationMode"]; quality_status: DailyBriefing["qualityStatus"];
  long_term_threads_json: string | null; candidate_count: number; selected_count: number;
  fetched_count: number | null; unique_count: number | null; balanced_count: number | null; synthesis_count: number | null;
}
interface ItemRow {
  id: string; briefing_id: string; category: BriefingItem["category"]; title: string; summary: string;
  what_changed: string | null; why_it_matters: string; suggested_action: string | null;
  item_type: BriefingItem["itemType"]; lede: string | null; nut_graf: string | null; key_facts_json: string;
  broader_context: string | null; implications: string | null; counterpoint: string | null;
  watch_next: string | null; zxlab_relevance: string | null;
  importance: number; confidence: number; sort_order: number;
}
interface SourceRow { id: string; item_id: string; title: string; url: string; publisher: string | null; published_at: string | null; }

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

interface BriefingRunDiagnosticRow {
  id: string; briefing_date: string; status: "running" | "succeeded" | "failed"; trigger_type: string;
  started_at: string; completed_at: string | null; candidate_count: number; selected_count: number;
  fetched_count: number | null; unique_count: number | null; balanced_count: number | null; synthesis_count: number | null;
  error_code: string | null; error_message: string | null; collection_run_id: string | null;
}

interface ModelInvocationDiagnosticRow {
  id: string; task: string; model: string; status: "running" | "succeeded" | "failed";
  started_at: string; completed_at: string | null; error_code: string | null;
}

export class BriefingRepository {
  constructor(private readonly db: D1Database) {}

  async latestDiagnostics(limit = 10): Promise<Array<{
    id: string; date: string; status: "running" | "succeeded" | "failed"; triggerType: string;
    startedAt: string; completedAt?: string; candidateCount: number; selectedCount: number;
    fetchedCount: number | null; uniqueCount: number | null; balancedCount: number | null;
    synthesisCount: number | null; publishedCount: number;
    errorCode?: string; collectionRunId?: string;
    invocations: Array<{ id: string; task: string; model: string; status: "running" | "succeeded" | "failed"; startedAt: string; completedAt?: string; errorCode?: string }>;
  }>> {
    const runs = await this.db.prepare(`SELECT id, briefing_date, status, trigger_type, started_at, completed_at,
      candidate_count, selected_count, fetched_count, unique_count, balanced_count, synthesis_count,
      error_code, error_message, collection_run_id
      FROM briefing_runs ORDER BY started_at DESC LIMIT ?`).bind(Math.min(Math.max(limit, 1), 20)).all<BriefingRunDiagnosticRow>();
    return Promise.all(runs.results.map(async (run) => {
      const invocations = await this.db.prepare(`SELECT id, task, model, status, started_at, completed_at, error_code
        FROM model_invocations WHERE run_id = ? ORDER BY started_at`).bind(run.id).all<ModelInvocationDiagnosticRow>();
      return {
        id: run.id, date: run.briefing_date, status: run.status, triggerType: run.trigger_type,
        startedAt: run.started_at, completedAt: run.completed_at ?? undefined,
        candidateCount: run.candidate_count, selectedCount: run.selected_count,
        fetchedCount: run.fetched_count,
        uniqueCount: run.unique_count,
        balancedCount: run.balanced_count,
        synthesisCount: run.synthesis_count,
        publishedCount: run.selected_count,
        errorCode: run.error_code ?? undefined,
        collectionRunId: run.collection_run_id ?? undefined,
        invocations: invocations.results.map((invocation) => ({
          id: invocation.id, task: invocation.task, model: invocation.model, status: invocation.status,
          startedAt: invocation.started_at, completedAt: invocation.completed_at ?? undefined,
          errorCode: invocation.error_code ?? undefined,
        })),
      };
    }));
  }

  async startRun(input: {
    id: string; date: string; triggerType: string; promptVersion: string; model: string; candidateCount: number;
    startedAt: string; collectionRunId?: string;
    stats?: { fetched: number | null; unique: number | null; balanced: number | null };
  }): Promise<void> {
    const stats = input.stats ?? { fetched: null, unique: null, balanced: null };
    await this.db.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, candidate_count, collection_run_id,
       fetched_count, unique_count, balanced_count, source_policy_version)
      VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='running', trigger_type=excluded.trigger_type,
        prompt_version=excluded.prompt_version, model=excluded.model, started_at=excluded.started_at,
        completed_at=NULL, candidate_count=excluded.candidate_count, selected_count=0,
        error_code=NULL, error_message=NULL, collection_run_id=excluded.collection_run_id,
        fetched_count=excluded.fetched_count, unique_count=excluded.unique_count,
        balanced_count=excluded.balanced_count, synthesis_count=NULL, source_policy_version=excluded.source_policy_version
      WHERE briefing_runs.status='failed'`)
      .bind(input.id, input.date, input.triggerType, input.promptVersion, input.model, input.startedAt, input.candidateCount,
        input.collectionRunId ?? null, stats.fetched, stats.unique, stats.balanced, SIGNAL_SOURCE_POLICY_VERSION).run();
  }

  async failRun(runId: string, code: string, _message?: string): Promise<void> {
    await this.db.prepare(`UPDATE briefing_runs SET status = 'failed', completed_at = ?, error_code = ?, error_message = ? WHERE id = ?`)
      .bind(new Date().toISOString(), code, null, runId).run();
  }

  async saveGenerated(input: {
    runId: string; briefingId: string; date: string; draft: GeneratedBriefingDraft; candidates: CandidateSignal[];
    promptVersion: string; model: string; dataOrigin: "fixture" | "real"; generatedAt: string; linkCandidates?: boolean;
    generationMode?: DailyBriefing["generationMode"]; qualityStatus?: DailyBriefing["qualityStatus"]; synthesisCount?: number;
  }): Promise<void> {
    const previous = await this.db.prepare("SELECT id FROM briefings WHERE briefing_date = ? AND is_active = 1 LIMIT 1")
      .bind(input.date).first<{ id: string }>();
    const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
    const statements: D1PreparedStatement[] = [];
    if (previous) statements.push(this.db.prepare("UPDATE briefings SET is_active = 0, status = 'superseded' WHERE id = ?").bind(previous.id));
    statements.push(this.db.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at, prompt_version, model,
       supersedes_id, long_term_threads_json, generation_mode, quality_status)
      VALUES (?, ?, ?, ?, ?, 'ready', 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.briefingId, input.runId, input.date, input.draft.title, input.draft.summary, input.dataOrigin, input.generatedAt,
        input.promptVersion, input.model, previous?.id ?? null, JSON.stringify(input.draft.longTermThreads),
        input.generationMode ?? "model", input.qualityStatus ?? "passed"));
    input.draft.items.forEach((item, index) => {
      const itemId = crypto.randomUUID();
      statements.push(this.db.prepare(`INSERT INTO briefing_items
        (id, briefing_id, category, title, summary, what_changed, why_it_matters, suggested_action, importance, confidence, sort_order,
         item_type, lede, nut_graf, key_facts_json, broader_context, implications, counterpoint, watch_next, zxlab_relevance)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(itemId, input.briefingId, item.category, item.title, item.lede, item.nutGraf, item.implications,
          item.importance, item.confidence, index, item.itemType, item.lede, item.nutGraf, JSON.stringify(item.keyFacts),
          item.broaderContext ?? null, item.implications, item.counterpoint ?? null, item.watchNext ?? null, item.zxlabRelevance ?? null));
      item.sourceIds.forEach((sourceId) => {
        const source = candidates.get(sourceId);
        if (!source) throw new SignalError("INVALID_MODEL_OUTPUT", "Generated briefing referenced an unknown source", 400);
        statements.push(this.db.prepare(`INSERT INTO briefing_sources (id, item_id, title, url, publisher, published_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), itemId, source.title, source.url, source.source.sourceName, source.publishedAt ?? null));
        if (input.linkCandidates) statements.push(this.db.prepare(`INSERT INTO briefing_item_candidates
          (briefing_item_id, candidate_signal_id, relation_type) VALUES (?, ?, ?)`)
          .bind(itemId, source.id, item.sourceIds[0] === sourceId ? "primary" : "supporting"));
      });
    });
    if (input.linkCandidates) {
      const selectedIds = new Set(input.draft.items.flatMap((item) => item.sourceIds));
      for (const source of input.candidates) {
        statements.push(this.db.prepare("UPDATE candidate_signals SET status=? WHERE id=?")
          .bind(selectedIds.has(source.id) ? "selected" : "filtered", source.id));
      }
    }
    statements.push(this.db.prepare(`UPDATE briefing_runs SET status = 'succeeded', completed_at = ?, selected_count = ?, synthesis_count = ? WHERE id = ?`)
      .bind(input.generatedAt, input.draft.items.length, input.synthesisCount ?? input.candidates.length, input.runId));
    try { await this.db.batch(statements); }
    catch (cause) { throw new SignalError("DATABASE_WRITE_FAILED", "The generated briefing could not be persisted", 500, cause); }
  }

  async getLatest(): Promise<DailyBriefing> {
    const row = await this.db.prepare(`${this.selectBriefing()} WHERE b.is_active = 1 ORDER BY b.briefing_date DESC, b.generated_at DESC LIMIT 1`).first<BriefingRow>();
    if (!row) throw new SignalError("BRIEFING_NOT_FOUND", "No active briefing is available", 404);
    return this.hydrate(row);
  }

  async getByDate(date: string): Promise<DailyBriefing> {
    const row = await this.db.prepare(`${this.selectBriefing()} WHERE b.briefing_date = ? AND b.is_active = 1 LIMIT 1`).bind(date).first<BriefingRow>();
    if (!row) throw new SignalError("BRIEFING_NOT_FOUND", `No active briefing exists for ${date}`, 404);
    return this.hydrate(row);
  }

  async getById(id: string): Promise<DailyBriefing> {
    const row = await this.db.prepare(`${this.selectBriefing()} WHERE b.id = ? LIMIT 1`).bind(id).first<BriefingRow>();
    if (!row) throw new SignalError("BRIEFING_NOT_FOUND", "Briefing not found", 404);
    return this.hydrate(row);
  }

  async recentItemsBefore(date: string, limit = 60): Promise<PriorBriefingContext[]> {
    const result = await this.db.prepare(`SELECT b.briefing_date, i.title, i.summary
      FROM briefing_items i JOIN briefings b ON b.id=i.briefing_id
      WHERE b.is_active=1 AND b.status IN ('ready','partial') AND b.briefing_date<?
      ORDER BY b.briefing_date DESC, i.sort_order LIMIT ?`)
      .bind(date, Math.min(Math.max(limit, 1), 120)).all<{ briefing_date: string; title: string; summary: string }>();
    return result.results.map((row) => ({ briefingDate: row.briefing_date, title: row.title, summary: row.summary }));
  }

  private selectBriefing(): string {
    return `SELECT b.id, b.run_id, b.briefing_date, b.title, b.summary, b.status, b.data_origin, b.generated_at,
      b.prompt_version, b.model, b.generation_mode, b.quality_status, b.long_term_threads_json,
      r.candidate_count, r.selected_count, r.fetched_count, r.unique_count, r.balanced_count, r.synthesis_count
      FROM briefings b JOIN briefing_runs r ON r.id = b.run_id`;
  }

  private async hydrate(row: BriefingRow): Promise<DailyBriefing> {
    const itemResult = await this.db.prepare("SELECT * FROM briefing_items WHERE briefing_id = ? ORDER BY sort_order").bind(row.id).all<ItemRow>();
    const sourceResult = await this.db.prepare(`SELECT s.* FROM briefing_sources s JOIN briefing_items i ON i.id = s.item_id WHERE i.briefing_id = ? ORDER BY i.sort_order`).bind(row.id).all<SourceRow>();
    const items = itemResult.results;
    const sources = sourceResult.results;
    return {
      id: row.id, date: row.briefing_date, status: row.status === "partial" ? "partial" : "ready", title: row.title, summary: row.summary,
      generatedAt: row.generated_at, promptVersion: row.prompt_version, model: row.model, dataOrigin: row.data_origin,
      generationMode: row.generation_mode ?? "legacy-unknown", qualityStatus: row.quality_status ?? "unknown",
      stats: {
        fetched: row.fetched_count,
        deduplicated: row.unique_count,
        balanced: row.balanced_count,
        synthesized: row.synthesis_count,
        selected: row.selected_count,
      },
      longTermThreads: parseJson<LongTermThread[]>(row.long_term_threads_json, []),
      items: items.map((item) => ({
        id: item.id,
        itemType: item.lede ? item.item_type : item.sort_order === 0 ? "lead" as const : "brief" as const,
        category: item.category,
        title: item.title,
        lede: item.lede ?? item.summary,
        nutGraf: item.nut_graf ?? item.what_changed ?? item.why_it_matters,
        keyFacts: parseJson<string[]>(item.key_facts_json, []),
        broaderContext: item.broader_context ?? undefined,
        implications: item.implications ?? item.why_it_matters,
        counterpoint: item.counterpoint ?? undefined,
        watchNext: item.watch_next ?? undefined,
        zxlabRelevance: item.zxlab_relevance ?? undefined,
        summary: item.summary, whatChanged: item.what_changed ?? undefined,
        whyItMatters: item.why_it_matters, suggestedAction: item.suggested_action ?? undefined, importance: item.importance, confidence: item.confidence,
        sources: sources.filter((source) => source.item_id === item.id).map((source) => ({ id: source.id, title: source.title, url: source.url, publisher: source.publisher ?? undefined, publishedAt: source.published_at ?? undefined })),
      })),
    };
  }
}
