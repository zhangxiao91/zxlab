import type { Annotation, AnnotationInput, AnnotationReply, BriefingItem, MemoryCandidate } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";

export interface AnnotationItemContext extends BriefingItem {
  briefingId: string;
}

interface ItemContextRow {
  id: string; briefing_id: string; category: BriefingItem["category"]; title: string; summary: string;
  what_changed: string | null; why_it_matters: string; suggested_action: string | null; importance: number; confidence: number;
}
interface SourceRow { id: string; title: string; url: string; publisher: string | null; published_at: string | null; }

export class AnnotationRepository {
  constructor(private readonly db: D1Database) {}

  async getItemContext(briefingId: string, itemId: string): Promise<AnnotationItemContext> {
    const item = await this.db.prepare("SELECT * FROM briefing_items WHERE id = ? AND briefing_id = ? LIMIT 1")
      .bind(itemId, briefingId).first<ItemContextRow>();
    if (!item) throw new SignalError("ITEM_NOT_FOUND", "The briefing item was not found", 404);
    const sourceResult = await this.db.prepare("SELECT * FROM briefing_sources WHERE item_id = ? ORDER BY published_at DESC").bind(itemId).all<SourceRow>();
    return {
      id: item.id, briefingId: item.briefing_id, category: item.category, title: item.title, summary: item.summary,
      whatChanged: item.what_changed ?? undefined, whyItMatters: item.why_it_matters, suggestedAction: item.suggested_action ?? undefined,
      importance: item.importance, confidence: item.confidence,
      sources: sourceResult.results.map((source) => ({ id: source.id, title: source.title, url: source.url, publisher: source.publisher ?? undefined, publishedAt: source.published_at ?? undefined })),
    };
  }

  async save(input: { request: AnnotationInput; annotation: Annotation; reply: AnnotationReply; memoryCandidate?: MemoryCandidate }): Promise<void> {
    const statements = [
      this.db.prepare(`INSERT INTO annotations (id, briefing_id, briefing_item_id, selected_text, comment, action_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(input.annotation.id, input.annotation.briefingId, input.annotation.briefingItemId, input.annotation.selectedText, input.annotation.comment, input.annotation.action, input.annotation.createdAt),
      this.db.prepare(`INSERT INTO annotation_messages (id, annotation_id, role, content, model, created_at) VALUES (?, ?, 'user', ?, NULL, ?)`)
        .bind(crypto.randomUUID(), input.annotation.id, input.request.comment, input.annotation.createdAt),
      this.db.prepare(`INSERT INTO annotation_messages (id, annotation_id, role, content, model, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)`)
        .bind(input.reply.id, input.annotation.id, input.reply.content, input.reply.model ?? null, input.reply.createdAt),
    ];
    if (input.memoryCandidate) {
      const namespace = input.memoryCandidate.scope === "project"
        ? input.memoryCandidate.scopeKey === "markets" ? "markets" : "zxlab"
        : input.memoryCandidate.scope === "preference" ? "global" : "briefing";
      const kind = input.memoryCandidate.scope === "preference" ? "preference"
        : input.memoryCandidate.scope === "belief" ? "fact"
          : input.memoryCandidate.scope === "project" ? "decision" : "summary";
      statements.push(this.db.prepare(`INSERT INTO memory_consolidation_candidates
        (id, action, reason, namespace, kind, content, importance, confidence, source_event_ids_json, status, created_at)
        VALUES (?, 'create', ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`)
        .bind(input.memoryCandidate.id, input.memoryCandidate.reason, namespace, kind, input.memoryCandidate.content,
          input.memoryCandidate.confidence, input.memoryCandidate.confidence, JSON.stringify([input.annotation.id]), input.memoryCandidate.createdAt));
    }
    try { await this.db.batch(statements); }
    catch (cause) { throw new SignalError("DATABASE_WRITE_FAILED", "The annotation could not be persisted", 500, cause); }
  }
}
