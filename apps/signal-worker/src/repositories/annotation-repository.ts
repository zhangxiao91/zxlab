import type { Annotation, AnnotationAction, AnnotationInput, AnnotationReply, AnnotationResponse, BriefingItem, MemoryCandidate, MemoryCandidateStatus } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import type { AnnotationOperationCommit } from "../services/annotation-operation";

export interface AnnotationItemContext extends BriefingItem {
  briefingId: string;
}

interface ItemContextRow {
  id: string; briefing_id: string; category: BriefingItem["category"]; title: string; summary: string;
  what_changed: string | null; why_it_matters: string; suggested_action: string | null; importance: number; confidence: number;
  item_type: BriefingItem["itemType"]; lede: string | null; nut_graf: string | null; key_facts_json: string;
  broader_context: string | null; implications: string | null; counterpoint: string | null;
  watch_next: string | null; zxlab_relevance: string | null; sort_order: number;
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
      id: item.id, briefingId: item.briefing_id,
      itemType: item.lede ? item.item_type : item.sort_order === 0 ? "lead" : "brief",
      category: item.category, title: item.title,
      lede: item.lede ?? item.summary, nutGraf: item.nut_graf ?? item.what_changed ?? item.why_it_matters,
      keyFacts: (() => { try { return JSON.parse(item.key_facts_json) as string[]; } catch { return []; } })(),
      broaderContext: item.broader_context ?? undefined, implications: item.implications ?? item.why_it_matters,
      counterpoint: item.counterpoint ?? undefined, watchNext: item.watch_next ?? undefined, zxlabRelevance: item.zxlab_relevance ?? undefined,
      summary: item.summary,
      whatChanged: item.what_changed ?? undefined, whyItMatters: item.why_it_matters, suggestedAction: item.suggested_action ?? undefined,
      importance: item.importance, confidence: item.confidence,
      sources: sourceResult.results.map((source) => ({ id: source.id, title: source.title, url: source.url, publisher: source.publisher ?? undefined, publishedAt: source.published_at ?? undefined })),
    };
  }

  async getResponse(annotationId: string): Promise<AnnotationResponse> {
    const annotation = await this.db.prepare(`SELECT id, briefing_id, briefing_item_id, selected_text, comment, action_type, created_at
      FROM annotations WHERE id=?`).bind(annotationId).first<{
        id: string; briefing_id: string; briefing_item_id: string; selected_text: string; comment: string;
        action_type: AnnotationAction; created_at: string;
      }>();
    if (!annotation) throw new SignalError("ITEM_NOT_FOUND", "Committed annotation was not found", 404);
    const reply = await this.db.prepare(`SELECT id, annotation_id, content, model, created_at FROM annotation_messages
      WHERE annotation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1`).bind(annotationId).first<{
        id: string; annotation_id: string; content: string; model: string | null; created_at: string;
      }>();
    if (!reply) throw new SignalError("ITEM_NOT_FOUND", "Committed annotation reply was not found", 404);
    const candidate = await this.db.prepare(`SELECT id, namespace, kind, content, confidence, reason, status, created_at, resolved_at
      FROM memory_consolidation_candidates WHERE source_event_ids_json=? ORDER BY created_at DESC LIMIT 1`)
      .bind(JSON.stringify([annotationId])).first<{
        id: string; namespace: string | null; kind: string | null; content: string | null; confidence: number | null;
        reason: string; status: MemoryCandidateStatus; created_at: string; resolved_at: string | null;
      }>();
    const memoryCandidate: MemoryCandidate | undefined = candidate?.content && candidate.confidence !== null ? {
      id: candidate.id,
      annotationId,
      scope: candidate.namespace === "global" ? "preference" : candidate.kind === "fact" ? "belief"
        : candidate.namespace === "briefing" ? "discussion" : "project",
      scopeKey: candidate.namespace === "zxlab" || candidate.namespace === "markets" ? candidate.namespace : undefined,
      content: candidate.content,
      confidence: candidate.confidence,
      reason: candidate.reason,
      status: candidate.status,
      createdAt: candidate.created_at,
      resolvedAt: candidate.resolved_at ?? undefined,
    } : undefined;
    return {
      annotation: { id: annotation.id, briefingId: annotation.briefing_id, briefingItemId: annotation.briefing_item_id,
        selectedText: annotation.selected_text, comment: annotation.comment, action: annotation.action_type, createdAt: annotation.created_at },
      reply: { id: reply.id, annotationId: reply.annotation_id, content: reply.content, model: reply.model ?? undefined, createdAt: reply.created_at },
      memoryCandidate,
    };
  }

  async save(input: { request: AnnotationInput; annotation: Annotation; reply: AnnotationReply; memoryCandidate?: MemoryCandidate;
    operation?: AnnotationOperationCommit }): Promise<void> {
    const statements = [
      this.db.prepare(`INSERT INTO annotations
        (id, briefing_id, briefing_item_id, selected_text, comment, action_type, created_at, operation_key_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(input.annotation.id, input.annotation.briefingId, input.annotation.briefingItemId, input.annotation.selectedText,
          input.annotation.comment, input.annotation.action, input.annotation.createdAt, input.operation?.keyHash ?? null),
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
    if (input.operation) {
      statements.push(this.db.prepare(`UPDATE annotation_operations SET status='succeeded', annotation_id=?, lease_token=NULL,
        lease_expires_at=NULL, error_code=NULL, updated_at=? WHERE key_hash=?`)
        .bind(input.annotation.id, input.annotation.createdAt, input.operation.keyHash));
    }
    try { await this.db.batch(statements); }
    catch (cause) { throw new SignalError("DATABASE_WRITE_FAILED", "The annotation could not be persisted", 500, cause); }
  }
}
