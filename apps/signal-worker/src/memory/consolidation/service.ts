import { SignalError } from "../../lib/errors";
import { UnifiedMemoryRepository } from "../repository/memory-repository";
import type { ConsolidationCandidate } from "../schema/types";
import { MemoryService } from "../service/memory-service";
import { MemoryConsolidationLLM } from "./llm";

export class MemoryConsolidationService {
  private readonly repository: UnifiedMemoryRepository;
  private readonly memory: MemoryService;
  private readonly llm: MemoryConsolidationLLM;

  constructor(env: Env, fetcher: typeof fetch = fetch) {
    this.repository = new UnifiedMemoryRepository(env.DB);
    this.memory = new MemoryService(env.DB);
    this.llm = new MemoryConsolidationLLM(env, fetcher);
  }

  async generate(limit: number): Promise<ConsolidationCandidate[]> {
    const events = await this.repository.recentEvents(limit);
    if (events.length === 0) return [];
    const active = await this.repository.activeItems();
    const proposed = await this.llm.propose(events, active);
    const created: ConsolidationCandidate[] = [];
    for (const candidate of proposed) created.push(await this.repository.createCandidate(candidate));
    return created;
  }

  async accept(id: string): Promise<{ candidate: ConsolidationCandidate; memory?: Awaited<ReturnType<MemoryService["create"]>> }> {
    const candidate = await this.repository.getCandidate(id);
    if (candidate.status !== "proposed") throw new SignalError("MEMORY_ALREADY_RESOLVED", "Consolidation candidate is already resolved", 409);
    let memory;
    if (candidate.action === "create") {
      if (!candidate.memory?.namespace || !candidate.memory.kind || !candidate.memory.content || candidate.memory.importance === undefined || candidate.memory.confidence === undefined) {
        throw new SignalError("INVALID_REQUEST", "Candidate has no complete memory proposal", 400);
      }
      memory = await this.memory.create({ ...candidate.memory as Required<typeof candidate.memory>, sourceType: "feedback_consolidation", sourceId: candidate.id });
    } else if (candidate.action === "update") {
      if (!candidate.memoryId || !candidate.memory) throw new SignalError("INVALID_REQUEST", "Candidate has no update target", 400);
      memory = await this.memory.update(candidate.memoryId, { ...candidate.memory, sourceType: "feedback_consolidation", sourceId: candidate.id, reason: candidate.reason });
    }
    return { candidate: await this.repository.resolveCandidate(id, "accepted"), memory };
  }

  async reject(id: string): Promise<ConsolidationCandidate> {
    return this.repository.resolveCandidate(id, "rejected");
  }
}
