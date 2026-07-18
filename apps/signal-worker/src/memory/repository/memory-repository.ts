import { SignalError } from "../../lib/errors";
import type { ConsolidationCandidate, FeedbackEvent, MemoryItem, MemoryRevision } from "../schema/types";

interface MemoryRow {
  id: string; namespace: MemoryItem["namespace"]; kind: MemoryItem["kind"]; content: string; importance: number; confidence: number;
  source_type: string; source_id: string | null; status: MemoryItem["status"]; created_at: string; updated_at: string; expires_at: string | null;
}
interface FeedbackRow { id: string; target_type: string; target_id: string; action: FeedbackEvent["action"]; comment: string | null; created_at: string; }
interface RevisionRow { id: string; memory_id: string; old_content: string; new_content: string; reason: string; created_at: string; }
interface CandidateRow {
  id: string; action: ConsolidationCandidate["action"]; reason: string; memory_id: string | null; namespace: MemoryItem["namespace"] | null;
  kind: MemoryItem["kind"] | null; content: string | null; importance: number | null; confidence: number | null;
  source_event_ids_json: string; status: ConsolidationCandidate["status"]; created_at: string; resolved_at: string | null;
}

function memory(row: MemoryRow): MemoryItem {
  return { id: row.id, namespace: row.namespace, kind: row.kind, content: row.content, importance: row.importance, confidence: row.confidence,
    sourceType: row.source_type, sourceId: row.source_id ?? undefined, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined };
}
function event(row: FeedbackRow): FeedbackEvent {
  return { id: row.id, targetType: row.target_type, targetId: row.target_id, action: row.action, comment: row.comment ?? undefined, createdAt: row.created_at };
}
function revision(row: RevisionRow): MemoryRevision {
  return { id: row.id, memoryId: row.memory_id, oldContent: row.old_content, newContent: row.new_content, reason: row.reason, createdAt: row.created_at };
}
function candidate(row: CandidateRow): ConsolidationCandidate {
  const hasMemory = row.namespace && row.kind && row.content !== null && row.importance !== null && row.confidence !== null;
  return { id: row.id, action: row.action, reason: row.reason, memoryId: row.memory_id ?? undefined,
    memory: hasMemory ? { namespace: row.namespace!, kind: row.kind!, content: row.content!, importance: row.importance!, confidence: row.confidence! } : undefined,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as string[], status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at ?? undefined };
}

export class UnifiedMemoryRepository {
  constructor(private readonly db: D1Database) {}

  async createEvent(input: Omit<FeedbackEvent, "id" | "createdAt">): Promise<FeedbackEvent> {
    const created: FeedbackEvent = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    await this.db.prepare(`INSERT INTO feedback_events (id, target_type, target_id, action, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(created.id, created.targetType, created.targetId, created.action, created.comment ?? null, created.createdAt).run();
    return created;
  }

  async recentEvents(limit: number): Promise<FeedbackEvent[]> {
    const result = await this.db.prepare("SELECT * FROM feedback_events ORDER BY created_at DESC LIMIT ?").bind(limit).all<FeedbackRow>();
    return result.results.map(event);
  }

  async createItem(input: Omit<MemoryItem, "id" | "status" | "createdAt" | "updatedAt">): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const created: MemoryItem = { ...input, id: crypto.randomUUID(), status: "active", createdAt: now, updatedAt: now };
    await this.db.prepare(`INSERT INTO memory_items
      (id, namespace, kind, content, importance, confidence, source_type, source_id, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .bind(created.id, created.namespace, created.kind, created.content, created.importance, created.confidence, created.sourceType,
        created.sourceId ?? null, now, now, created.expiresAt ?? null).run();
    return created;
  }

  async getItem(id: string): Promise<MemoryItem> {
    const row = await this.db.prepare("SELECT * FROM memory_items WHERE id = ? LIMIT 1").bind(id).first<MemoryRow>();
    if (!row) throw new SignalError("MEMORY_CANDIDATE_NOT_FOUND", "Memory item not found", 404);
    return memory(row);
  }

  async updateItem(id: string, input: Partial<Omit<MemoryItem, "id" | "createdAt" | "updatedAt" | "status">> & { reason: string }): Promise<MemoryItem> {
    const current = await this.getItem(id);
    if (current.status !== "active") throw new SignalError("MEMORY_ALREADY_RESOLVED", "Only active memory can be updated", 409);
    const next = { ...current, ...input, updatedAt: new Date().toISOString() };
    const revisionId = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare(`INSERT INTO memory_revisions (id, memory_id, old_content, new_content, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(revisionId, id, current.content, next.content, input.reason, next.updatedAt),
      this.db.prepare(`UPDATE memory_items SET namespace = ?, kind = ?, content = ?, importance = ?, confidence = ?, source_type = ?, source_id = ?, updated_at = ?, expires_at = ? WHERE id = ? AND status = 'active'`)
        .bind(next.namespace, next.kind, next.content, next.importance, next.confidence, next.sourceType, next.sourceId ?? null, next.updatedAt, next.expiresAt ?? null, id),
    ]);
    return this.getItem(id);
  }

  async forgetItem(id: string, reason: string): Promise<MemoryItem> {
    const current = await this.getItem(id);
    if (current.status === "forgotten") return current;
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(`INSERT INTO memory_revisions (id, memory_id, old_content, new_content, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, current.content, current.content, reason, now),
      this.db.prepare("UPDATE memory_items SET status = 'forgotten', updated_at = ? WHERE id = ?").bind(now, id),
    ]);
    return this.getItem(id);
  }

  async activeItems(namespaces?: MemoryItem["namespace"][]): Promise<MemoryItem[]> {
    const now = new Date().toISOString();
    if (!namespaces?.length) {
      const result = await this.db.prepare(`SELECT * FROM memory_items WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 500`)
        .bind(now).all<MemoryRow>();
      return result.results.map(memory);
    }
    const placeholders = namespaces.map(() => "?").join(",");
    const result = await this.db.prepare(`SELECT * FROM memory_items WHERE status = 'active' AND namespace IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 500`)
      .bind(...namespaces, now).all<MemoryRow>();
    return result.results.map(memory);
  }

  async listItems(limit = 200): Promise<MemoryItem[]> {
    const result = await this.db.prepare("SELECT * FROM memory_items ORDER BY updated_at DESC LIMIT ?").bind(limit).all<MemoryRow>();
    return result.results.map(memory);
  }

  async revisions(memoryId?: string): Promise<MemoryRevision[]> {
    const result = memoryId
      ? await this.db.prepare("SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY created_at DESC LIMIT 200").bind(memoryId).all<RevisionRow>()
      : await this.db.prepare("SELECT * FROM memory_revisions ORDER BY created_at DESC LIMIT 500").all<RevisionRow>();
    return result.results.map(revision);
  }

  async createCandidate(input: Omit<ConsolidationCandidate, "id" | "status" | "createdAt" | "resolvedAt">): Promise<ConsolidationCandidate> {
    const created: ConsolidationCandidate = { ...input, id: crypto.randomUUID(), status: "proposed", createdAt: new Date().toISOString() };
    await this.db.prepare(`INSERT INTO memory_consolidation_candidates
      (id, action, reason, memory_id, namespace, kind, content, importance, confidence, source_event_ids_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`)
      .bind(created.id, created.action, created.reason, created.memoryId ?? null, created.memory?.namespace ?? null, created.memory?.kind ?? null,
        created.memory?.content ?? null, created.memory?.importance ?? null, created.memory?.confidence ?? null,
        JSON.stringify(created.sourceEventIds), created.createdAt).run();
    return created;
  }

  async listCandidates(): Promise<ConsolidationCandidate[]> {
    const result = await this.db.prepare("SELECT * FROM memory_consolidation_candidates ORDER BY created_at DESC LIMIT 200").all<CandidateRow>();
    return result.results.map(candidate);
  }

  async getCandidate(id: string): Promise<ConsolidationCandidate> {
    const row = await this.db.prepare("SELECT * FROM memory_consolidation_candidates WHERE id = ? LIMIT 1").bind(id).first<CandidateRow>();
    if (!row) throw new SignalError("MEMORY_CANDIDATE_NOT_FOUND", "Consolidation candidate not found", 404);
    return candidate(row);
  }

  async resolveCandidate(id: string, status: "accepted" | "rejected"): Promise<ConsolidationCandidate> {
    const existing = await this.getCandidate(id);
    if (existing.status !== "proposed") throw new SignalError("MEMORY_ALREADY_RESOLVED", "Consolidation candidate is already resolved", 409);
    const resolvedAt = new Date().toISOString();
    await this.db.prepare("UPDATE memory_consolidation_candidates SET status = ?, resolved_at = ? WHERE id = ? AND status = 'proposed'")
      .bind(status, resolvedAt, id).run();
    return { ...existing, status, resolvedAt };
  }
}
