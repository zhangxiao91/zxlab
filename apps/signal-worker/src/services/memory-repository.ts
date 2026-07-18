import type { MemoriesResponse, MemoryCandidate, MemoryEntry, MemoryScope, ResolveMemoryCandidateRequest } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";

interface MemoryRow {
  id: string; scope: MemoryScope; scope_key: string | null; content: string; confidence: number; status: MemoryEntry["status"];
  created_at: string; updated_at: string; last_confirmed_at: string; expires_at: string | null;
}
interface CandidateRow {
  id: string; annotation_id: string; proposed_scope: MemoryScope; scope_key: string | null; content: string; confidence: number;
  reason: string; status: MemoryCandidate["status"]; created_at: string; resolved_at: string | null;
}

function mapMemory(row: MemoryRow): MemoryEntry {
  return { id: row.id, scope: row.scope, scopeKey: row.scope_key ?? undefined, content: row.content, confidence: row.confidence,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, lastConfirmedAt: row.last_confirmed_at, expiresAt: row.expires_at ?? undefined };
}

function mapCandidate(row: CandidateRow): MemoryCandidate {
  return { id: row.id, annotationId: row.annotation_id, scope: row.proposed_scope, scopeKey: row.scope_key ?? undefined,
    content: row.content, confidence: row.confidence, reason: row.reason, status: row.status, createdAt: row.created_at, resolvedAt: row.resolved_at ?? undefined };
}

export class MemoryRepository {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<MemoriesResponse> {
    const memories = await this.db.prepare("SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT 200").all<MemoryRow>();
    const candidates = await this.db.prepare("SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT 200").all<CandidateRow>();
    return {
      memories: memories.results.map(mapMemory),
      candidates: candidates.results.map(mapCandidate),
    };
  }

  async active(): Promise<MemoryEntry[]> {
    const now = new Date().toISOString();
    const result = await this.db.prepare(`SELECT * FROM memory_entries WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 100`)
      .bind(now).all<MemoryRow>();
    return result.results.map(mapMemory);
  }

  async relevantTo(text: string): Promise<MemoryEntry[]> {
    const memories = await this.active();
    const normalized = text.toLowerCase();
    const keywords = normalized.match(/[a-z0-9][a-z0-9.+#-]{2,}|[\u4e00-\u9fff]{2,6}/g) ?? [];
    return memories
      .map((memory) => ({ memory, score: keywords.reduce((score, keyword) => score + (memory.content.toLowerCase().includes(keyword) ? 1 : 0), 0) + (memory.scopeKey && normalized.includes(memory.scopeKey.toLowerCase()) ? 3 : 0) }))
      .filter(({ score, memory }) => score > 0 || memory.scope === "preference")
      .sort((left, right) => right.score - left.score)
      .slice(0, 8)
      .map(({ memory }) => memory);
  }

  async accept(id: string, request: ResolveMemoryCandidateRequest): Promise<{ candidate: MemoryCandidate; memory: MemoryEntry }> {
    const candidate = await this.getCandidate(id);
    if (candidate.status !== "proposed") throw new SignalError("MEMORY_ALREADY_RESOLVED", "This memory candidate has already been resolved", 409);
    const scope = request.scope ?? candidate.scope;
    const scopeKey = request.scopeKey ?? candidate.scopeKey ?? (scope === "project" ? "zxlab" : undefined);
    if (scope === "project" && !scopeKey) throw new SignalError("INVALID_REQUEST", "Project memory requires scopeKey", 400);
    if (scope !== "discussion" && request.expiresAt) throw new SignalError("INVALID_REQUEST", "Only discussion memory can expire", 400);
    if (request.expiresAt && request.expiresAt <= new Date().toISOString()) throw new SignalError("INVALID_REQUEST", "Discussion memory expiration must be in the future", 400);
    const now = new Date().toISOString();
    const memoryId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const content = scope === "belief" && !/^用户当前(的)?判断/.test(candidate.content)
      ? `用户当前判断：${candidate.content}`
      : candidate.content;
    await this.db.batch([
      this.db.prepare("UPDATE memory_candidates SET status = 'accepted', proposed_scope = ?, scope_key = ?, resolved_at = ? WHERE id = ? AND status = 'proposed'")
        .bind(scope, scopeKey ?? null, now, id),
      this.db.prepare(`INSERT INTO memory_entries
        (id, scope, scope_key, content, confidence, status, created_at, updated_at, last_confirmed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(memoryId, scope, scopeKey ?? null, content, candidate.confidence, now, now, now, request.expiresAt ?? null),
      this.db.prepare(`INSERT INTO memory_events
        (id, memory_entry_id, event_type, source_annotation_id, previous_content, new_content, created_at)
        VALUES (?, ?, 'accepted', ?, NULL, ?, ?)`)
        .bind(eventId, memoryId, candidate.annotationId, content, now),
    ]);
    return {
      candidate: { ...candidate, scope, scopeKey, status: "accepted", resolvedAt: now },
      memory: { id: memoryId, scope, scopeKey, content, confidence: candidate.confidence, status: "active", createdAt: now, updatedAt: now, lastConfirmedAt: now, expiresAt: request.expiresAt },
    };
  }

  async reject(id: string): Promise<MemoryCandidate> {
    const candidate = await this.getCandidate(id);
    if (candidate.status !== "proposed") throw new SignalError("MEMORY_ALREADY_RESOLVED", "This memory candidate has already been resolved", 409);
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare("UPDATE memory_candidates SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'proposed'").bind(now, id),
      this.db.prepare(`INSERT INTO memory_events
        (id, memory_entry_id, event_type, source_annotation_id, previous_content, new_content, created_at)
        VALUES (?, NULL, 'rejected', ?, ?, NULL, ?)`)
        .bind(crypto.randomUUID(), candidate.annotationId, candidate.content, now),
    ]);
    return { ...candidate, status: "rejected", resolvedAt: now };
  }

  private async getCandidate(id: string): Promise<MemoryCandidate> {
    const row = await this.db.prepare("SELECT * FROM memory_candidates WHERE id = ? LIMIT 1").bind(id).first<CandidateRow>();
    if (!row) throw new SignalError("MEMORY_CANDIDATE_NOT_FOUND", "Memory candidate not found", 404);
    return mapCandidate(row);
  }
}
