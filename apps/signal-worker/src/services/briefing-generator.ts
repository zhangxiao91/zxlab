import type { CandidateSignal, GenerateBriefingResponse } from "@zxlab/signal-schema";
import fixtureCandidates from "../../fixtures/candidates.json";
import { parseCandidateSignal } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { BriefingRepository } from "../repositories/briefing-repository";
import { BRIEFING_PROMPT_VERSION } from "./prompts";
import type { SignalLLM } from "./llm";
import { MemoryService } from "../memory/service/memory-service";
import { MemoryRepository } from "./memory-repository";
import { CollectionRepository } from "../repositories/collection-repository";
import { fixtureCandidate } from "./candidate-normalizer";

export class BriefingGenerator {
  private readonly briefings: BriefingRepository;
  private readonly unifiedMemories: MemoryService;
  private readonly legacyMemories: MemoryRepository;
  private readonly candidates: CollectionRepository;

  constructor(private readonly env: Env, private readonly llm: SignalLLM) {
    this.briefings = new BriefingRepository(env.DB);
    this.unifiedMemories = new MemoryService(env.DB);
    this.legacyMemories = new MemoryRepository(env.DB);
    this.candidates = new CollectionRepository(env.DB);
  }

  fixture(): CandidateSignal[] {
    return fixtureCandidates.map((value) => parseCandidateSignal(fixtureCandidate(value as Parameters<typeof fixtureCandidate>[0])));
  }

  async generate(input: { date: string; candidates: CandidateSignal[]; dataOrigin: "fixture" | "real"; collectionRunId?: string }): Promise<GenerateBriefingResponse> {
    if (input.candidates.length === 0) throw new SignalError("INVALID_REQUEST", "At least one candidate is required", 400);
    const runId = crypto.randomUUID();
    const briefingId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.briefings.startRun({ id: runId, date: input.date, triggerType: "manual", promptVersion: BRIEFING_PROMPT_VERSION,
      model: this.env.ZX_SIGNAL_LLM_LABEL, candidateCount: input.candidates.length, startedAt, collectionRunId: input.collectionRunId });
    try {
      const retrieved = await this.unifiedMemories.retrieve({
        task: "signal-briefing",
        namespaces: ["briefing", "zxlab", "global", "markets"],
        query: input.candidates.map((candidate) => `${candidate.title} ${candidate.summary ?? ""}`).join("\n").slice(0, 8_000),
        limit: 16,
        tokenBudget: 2_000,
      });
      const canonicalMemories = retrieved.memories.map((item) => ({
        id: item.id,
        scope: item.kind === "preference" ? "preference" as const : "project" as const,
        scopeKey: item.namespace,
        content: item.content,
        confidence: item.confidence,
        status: "active" as const,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastConfirmedAt: item.updatedAt,
        expiresAt: item.expiresAt,
      }));
      const migratedIds = new Set(canonicalMemories.map((item) => item.id));
      const legacyMemories = (await this.legacyMemories.active()).filter((item) => !migratedIds.has(item.id));
      const memories = [...canonicalMemories, ...legacyMemories].slice(0, 20);
      let synthesisCandidates = input.candidates;
      if (input.dataOrigin === "real") {
        const decisions = await this.llm.filterCandidates({ candidates: input.candidates, memories, runId });
        await this.candidates.saveEditorialDecisions(decisions);
        const kept = new Set(decisions.filter((decision) => decision.decision === "keep").map((decision) => decision.candidateId));
        synthesisCandidates = input.candidates.filter((candidate) => kept.has(candidate.id));
        if (synthesisCandidates.length === 0) throw new SignalError("NO_ELIGIBLE_CANDIDATES", "Editorial filter kept no candidates", 422);
      }
      const draft = await this.llm.generateBriefing({ date: input.date, candidates: synthesisCandidates, memories, runId });
      const generatedAt = new Date().toISOString();
      await this.briefings.saveGenerated({ runId, briefingId, date: input.date, draft, candidates: synthesisCandidates,
        promptVersion: BRIEFING_PROMPT_VERSION, model: this.env.ZX_SIGNAL_LLM_LABEL, dataOrigin: input.dataOrigin,
        generatedAt, linkCandidates: input.dataOrigin === "real" });
      return { runId, briefing: await this.briefings.getById(briefingId) };
    } catch (cause) {
      const code = cause instanceof SignalError ? cause.code : "MODEL_REQUEST_FAILED";
      const message = cause instanceof Error ? cause.message : "Unknown generation failure";
      await this.briefings.failRun(runId, code, message);
      throw cause;
    }
  }
}
