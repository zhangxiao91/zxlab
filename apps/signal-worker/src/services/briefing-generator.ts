import type { CandidateSignal, GenerateBriefingResponse } from "@zxlab/signal-schema";
import fixtureCandidates from "../../fixtures/candidates.json";
import { parseCandidateSignal } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { BriefingRepository } from "../repositories/briefing-repository";
import { BRIEFING_PROMPT_VERSION } from "./prompts";
import type { SignalLLM } from "./llm";
import { MemoryRepository } from "./memory-repository";
import { CollectionRepository } from "../repositories/collection-repository";
import { fixtureCandidate } from "./candidate-normalizer";

export class BriefingGenerator {
  private readonly briefings: BriefingRepository;
  private readonly memories: MemoryRepository;
  private readonly candidates: CollectionRepository;

  constructor(private readonly env: Env, private readonly llm: SignalLLM) {
    this.briefings = new BriefingRepository(env.DB);
    this.memories = new MemoryRepository(env.DB);
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
      const memories = await this.memories.active();
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
