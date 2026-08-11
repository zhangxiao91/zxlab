import { SignalError } from "../../lib/errors";
import { UnifiedMemoryRepository } from "../repository/memory-repository";
import type { MemoryItem, RetrievedMemory, RetrieveMemoryInput, RetrieveMemoryResult } from "../schema/types";

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{2,}|[\u3400-\u9fff]{2,6}/g) ?? [])].slice(0, 80);
}

function tokenEstimate(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk * 0.75 + (text.length - cjk) / 4);
}

export class MemoryService {
  readonly repository: UnifiedMemoryRepository;

  constructor(db: D1Database) {
    this.repository = new UnifiedMemoryRepository(db);
  }

  async retrieve(input: RetrieveMemoryInput): Promise<RetrieveMemoryResult> {
    const now = Date.now();
    const queryTerms = terms(`${input.task} ${input.query}`);
    const candidates = await this.repository.activeItems(input.namespaces);
    const ranked = candidates.map((item) => {
      const haystack = item.content.toLowerCase();
      const lexical = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) / Math.max(1, queryTerms.length);
      const namespace = input.namespaces.indexOf(item.namespace);
      const namespaceScore = namespace < 0 ? 0 : 1 - namespace / Math.max(1, input.namespaces.length) * 0.25;
      const ageDays = Math.max(0, now - Date.parse(item.updatedAt)) / 86_400_000;
      const recency = 1 / (1 + ageDays / 90);
      return { item, score: namespaceScore * 0.3 + item.importance * 0.25 + item.confidence * 0.2 + recency * 0.1 + lexical * 0.15 };
    }).sort((left, right) => right.score - left.score);

    const selected: MemoryItem[] = [];
    let used = 0;
    for (const { item } of ranked) {
      if (selected.length >= input.limit) break;
      const estimate = tokenEstimate(item.content) + 12;
      if (used + estimate > input.tokenBudget) continue;
      selected.push(item);
      used += estimate;
    }
    const summary = selected.length === 0
      ? "No relevant long-term memory was found."
      : selected.map((item) => `[${item.namespace}/${item.kind}] ${item.content}`).join("\n");
    const memories = await Promise.all(selected.map(async (item): Promise<RetrievedMemory> => ({
      ...item,
      revisionHash: await memoryRevisionHash(item),
    })));
    return { memories, summary, tokenEstimate: tokenEstimate(summary) };
  }

  async create(input: Omit<MemoryItem, "id" | "status" | "createdAt" | "updatedAt">): Promise<MemoryItem> {
    if (input.expiresAt && input.expiresAt <= new Date().toISOString()) throw new SignalError("INVALID_REQUEST", "expiresAt must be in the future", 400);
    return this.repository.createItem(input);
  }

  async update(id: string, input: Partial<Omit<MemoryItem, "id" | "createdAt" | "updatedAt" | "status">> & { reason: string }): Promise<MemoryItem> {
    return this.repository.updateItem(id, input);
  }

  async forget(id: string, reason: string): Promise<MemoryItem> {
    return this.repository.forgetItem(id, reason);
  }
}

export async function memoryRevisionHash(item: MemoryItem): Promise<`sha256:${string}`> {
  const canonical = JSON.stringify({
    id: item.id,
    namespace: item.namespace,
    kind: item.kind,
    content: item.content,
    importance: item.importance,
    confidence: item.confidence,
    sourceType: item.sourceType,
    sourceId: item.sourceId ?? null,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt ?? null,
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
