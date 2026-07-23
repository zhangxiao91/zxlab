import type { BriefingItem, CandidateSignal, DailyBriefing, GeneratedBriefingDraft } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";

interface BriefingRow {
  id: string; run_id: string; briefing_date: string; title: string; summary: string; status: string;
  data_origin: "fixture" | "real"; generated_at: string; prompt_version: string; model: string;
  candidate_count: number; selected_count: number;
}
interface ItemRow {
  id: string; briefing_id: string; category: BriefingItem["category"]; title: string; summary: string;
  what_changed: string | null; why_it_matters: string; suggested_action: string | null;
  importance: number; confidence: number; sort_order: number;
}
interface SourceRow { id: string; item_id: string; title: string; url: string; publisher: string | null; published_at: string | null; }

interface BriefingRunDiagnosticRow {
  id: string; briefing_date: string; status: "running" | "succeeded" | "failed"; trigger_type: string;
  started_at: string; completed_at: string | null; candidate_count: number; selected_count: number;
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
    errorCode?: string; errorMessage?: string; collectionRunId?: string;
    invocations: Array<{ id: string; task: string; model: string; status: "running" | "succeeded" | "failed"; startedAt: string; completedAt?: string; errorCode?: string }>;
  }>> {
    const runs = await this.db.prepare(`SELECT id, briefing_date, status, trigger_type, started_at, completed_at,
      candidate_count, selected_count, error_code, error_message, collection_run_id
      FROM briefing_runs ORDER BY started_at DESC LIMIT ?`).bind(Math.min(Math.max(limit, 1), 20)).all<BriefingRunDiagnosticRow>();
    return Promise.all(runs.results.map(async (run) => {
      const invocations = await this.db.prepare(`SELECT id, task, model, status, started_at, completed_at, error_code
        FROM model_invocations WHERE run_id = ? ORDER BY started_at`).bind(run.id).all<ModelInvocationDiagnosticRow>();
      return {
        id: run.id, date: run.briefing_date, status: run.status, triggerType: run.trigger_type,
        startedAt: run.started_at, completedAt: run.completed_at ?? undefined,
        candidateCount: run.candidate_count, selectedCount: run.selected_count,
        errorCode: run.error_code ?? undefined, errorMessage: run.error_message ?? undefined,
        collectionRunId: run.collection_run_id ?? undefined,
        invocations: invocations.results.map((invocation) => ({
          id: invocation.id, task: invocation.task, model: invocation.model, status: invocation.status,
          startedAt: invocation.started_at, completedAt: invocation.completed_at ?? undefined,
          errorCode: invocation.error_code ?? undefined,
        })),
      };
    }));
  }

  async startRun(input: { id: string; date: string; triggerType: string; promptVersion: string; model: string; candidateCount: number; startedAt: string; collectionRunId?: string }): Promise<void> {
    await this.db.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, candidate_count, collection_run_id)
      VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
      .bind(input.id, input.date, input.triggerType, input.promptVersion, input.model, input.startedAt, input.candidateCount, input.collectionRunId ?? null).run();
  }

  async failRun(runId: string, code: string, message: string): Promise<void> {
    await this.db.prepare(`UPDATE briefing_runs SET status = 'failed', completed_at = ?, error_code = ?, error_message = ? WHERE id = ?`)
      .bind(new Date().toISOString(), code, message.slice(0, 500), runId).run();
  }

  async saveGenerated(input: {
    runId: string; briefingId: string; date: string; draft: GeneratedBriefingDraft; candidates: CandidateSignal[];
    promptVersion: string; model: string; dataOrigin: "fixture" | "real"; generatedAt: string; linkCandidates?: boolean;
  }): Promise<void> {
    const previous = await this.db.prepare("SELECT id FROM briefings WHERE briefing_date = ? AND is_active = 1 LIMIT 1")
      .bind(input.date).first<{ id: string }>();
    const candidates = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
    const statements: D1PreparedStatement[] = [];
    if (previous) statements.push(this.db.prepare("UPDATE briefings SET is_active = 0, status = 'superseded' WHERE id = ?").bind(previous.id));
    statements.push(this.db.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at, prompt_version, model, supersedes_id)
      VALUES (?, ?, ?, ?, ?, 'ready', 1, ?, ?, ?, ?, ?)`)
      .bind(input.briefingId, input.runId, input.date, input.draft.title, input.draft.summary, input.dataOrigin, input.generatedAt, input.promptVersion, input.model, previous?.id ?? null));
    input.draft.items.forEach((item, index) => {
      const itemId = crypto.randomUUID();
      statements.push(this.db.prepare(`INSERT INTO briefing_items
        (id, briefing_id, category, title, summary, what_changed, why_it_matters, suggested_action, importance, confidence, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(itemId, input.briefingId, item.category, item.title, item.summary, item.whatChanged ?? null, item.whyItMatters, item.suggestedAction ?? null, item.importance, item.confidence, index));
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
    statements.push(this.db.prepare(`UPDATE briefing_runs SET status = 'succeeded', completed_at = ?, selected_count = ? WHERE id = ?`)
      .bind(input.generatedAt, input.draft.items.length, input.runId));
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

  private selectBriefing(): string {
    return `SELECT b.id, b.run_id, b.briefing_date, b.title, b.summary, b.status, b.data_origin, b.generated_at,
      b.prompt_version, b.model, r.candidate_count, r.selected_count FROM briefings b JOIN briefing_runs r ON r.id = b.run_id`;
  }

  private async hydrate(row: BriefingRow): Promise<DailyBriefing> {
    const itemResult = await this.db.prepare("SELECT * FROM briefing_items WHERE briefing_id = ? ORDER BY sort_order").bind(row.id).all<ItemRow>();
    const sourceResult = await this.db.prepare(`SELECT s.* FROM briefing_sources s JOIN briefing_items i ON i.id = s.item_id WHERE i.briefing_id = ? ORDER BY i.sort_order`).bind(row.id).all<SourceRow>();
    const items = itemResult.results;
    const sources = sourceResult.results;
    return {
      id: row.id, date: row.briefing_date, status: row.status === "partial" ? "partial" : "ready", title: row.title, summary: row.summary,
      generatedAt: row.generated_at, promptVersion: row.prompt_version, model: row.model, dataOrigin: row.data_origin,
      stats: { fetched: row.candidate_count, deduplicated: row.candidate_count, selected: row.selected_count },
      items: items.map((item) => ({
        id: item.id, category: item.category, title: item.title, summary: item.summary, whatChanged: item.what_changed ?? undefined,
        whyItMatters: item.why_it_matters, suggestedAction: item.suggested_action ?? undefined, importance: item.importance, confidence: item.confidence,
        sources: sources.filter((source) => source.item_id === item.id).map((source) => ({ id: source.id, title: source.title, url: source.url, publisher: source.publisher ?? undefined, publishedAt: source.published_at ?? undefined })),
      })),
    };
  }
}
