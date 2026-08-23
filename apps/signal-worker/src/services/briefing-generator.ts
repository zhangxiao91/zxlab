import type { BriefingCategory, CandidateSignal, GenerateBriefingResponse, GeneratedBriefingDraft } from "@zxlab/signal-schema";
import fixtureCandidates from "../../fixtures/candidates.json";
import { parseCandidateSignal, parseGeneratedBriefingDraft } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { BriefingRepository } from "../repositories/briefing-repository";
import { BRIEFING_PROMPT_VERSION } from "./prompts";
import type { SignalLLM } from "./llm";
import { MemoryService } from "../memory/service/memory-service";
import { CollectionRepository } from "../repositories/collection-repository";
import { fixtureCandidate } from "./candidate-normalizer";
import { buildStoryDossiers, selectStoryDossiers } from "./story-context";
import type { CandidateEditorialDecision } from "@zxlab/signal-schema";
import { GatewayRequestError } from "./gateway-client";
import { WatchModule } from "../watch/watch-module";
import { assertEditionQuality, selectUniqueEditionCandidates } from "./edition-quality";
import type { DailyPipelineCheckpoint } from "./daily-pipeline-runner";

const HISTORY_WINDOW_DAYS = 30;
const EDITORIAL_FALLBACK_LIMIT = 12;
const EDITORIAL_FALLBACK_REASON = "Deterministic fallback after a temporary editorial gateway failure.";
const BRIEFING_FALLBACK_LIMIT = 12;

function transientModelFailure(cause: unknown): GatewayRequestError | Error | undefined {
  let current = cause;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof SignalError && current.code === "INVALID_MODEL_OUTPUT") return undefined;
    if (current instanceof GatewayRequestError && (
      current.failureCode.includes("ALL_CANDIDATES_FAILED")
      || current.failureCode.includes("TIMEOUT")
      || current.failureCode.startsWith("FETCH_")
    )) return current;
    if (current.name === "TimeoutError" || current instanceof TypeError) return current;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trimEnd();
}

function fallbackCategory(candidate: CandidateSignal): BriefingCategory {
  return candidate.categoryHint === "uncategorized" ? "zxlab" : candidate.categoryHint;
}

export function deterministicBriefingFallback(date: string, candidates: CandidateSignal[]): GeneratedBriefingDraft {
  const selected = candidates.slice(0, BRIEFING_FALLBACK_LIMIT);
  const items: GeneratedBriefingDraft["items"] = selected.map((candidate, index) => {
    const sourceName = truncate(candidate.source.sourceName, 160);
    const summary = truncate(candidate.summary ?? candidate.contentText ?? candidate.title, 3_000);
    const leadFields = index === 0 ? {
      broaderContext: "本期简报由已筛选的原始信号确定性生成，保留来源与链接，未进行跨来源模型综合。",
      counterpoint: "模型服务暂时不可用，条目的优先级和影响判断尚未经过模型复核。",
      watchNext: "模型服务恢复后，继续核对后续进展与跨来源关联。",
    } : {};
    return {
      itemType: index === 0 ? "lead" as const : "brief" as const,
      category: fallbackCategory(candidate),
      title: truncate(candidate.title, 240),
      lede: summary,
      nutGraf: truncate(`该信号由 ${sourceName} 发布，原始内容与链接已保留供直接核验。`, 3_000),
      keyFacts: [truncate(summary, 1_000)],
      implications: "该更新进入今日 Signal 候选集，值得结合原始来源判断其后续影响。",
      importance: index === 0 ? 70 : 55,
      confidence: 60,
      sourceIds: [candidate.id],
      ...leadFields,
    };
  });
  return parseGeneratedBriefingDraft({
    title: `${date} Signal 日报`,
    summary: `模型服务暂时不可用。本期基于 ${selected.length} 条已筛选原始信号生成，并保留可核验来源。`,
    longTermThreads: [],
    items,
  }, new Set(selected.map((candidate) => candidate.id)));
}

export function deterministicEditorialFallback(candidates: CandidateSignal[]): CandidateEditorialDecision[] {
  return candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    decision: index < EDITORIAL_FALLBACK_LIMIT ? "keep" as const : "drop" as const,
    category: candidate.categoryHint,
    relevance: index < EDITORIAL_FALLBACK_LIMIT ? 60 : 40,
    novelty: index < EDITORIAL_FALLBACK_LIMIT ? 60 : 40,
    actionability: 50,
    sourceQuality: 60,
    reason: EDITORIAL_FALLBACK_REASON,
    relatedMemoryIds: [],
  }));
}

export function selectSynthesisCandidates(candidates: CandidateSignal[], decisions: CandidateEditorialDecision[]): CandidateSignal[] {
  const kept = new Set(decisions.filter((decision) => decision.decision === "keep").map((decision) => decision.candidateId));
  const supporting = new Set(decisions
    .filter((decision) => decision.decision === "merge" && decision.mergeTargetCandidateId && kept.has(decision.mergeTargetCandidateId))
    .map((decision) => decision.candidateId));
  return candidates.filter((candidate) => kept.has(candidate.id) || supporting.has(candidate.id));
}

export interface BriefingGenerationInput {
  date: string;
  candidates: CandidateSignal[];
  dataOrigin: "fixture" | "real";
  collectionRunId?: string;
  triggerType?: "manual" | "workflow";
  sourceQualityDegraded?: boolean;
  stats?: { fetched: number | null; unique: number | null; balanced: number | null };
  onStage?: (stage: "filtering" | "generating" | "validating" | "publishing") => Promise<void>;
  runId?: string;
  briefingId?: string;
  checkpoint?: DailyPipelineCheckpoint;
  onCheckpoint?: (checkpoint: Partial<DailyPipelineCheckpoint>) => Promise<void>;
}

function candidatesFromCheckpoint(
  candidates: CandidateSignal[],
  ids: string[],
  label: "synthesis",
): CandidateSignal[] {
  if (new Set(ids).size !== ids.length) {
    throw new SignalError("DATABASE_WRITE_FAILED", `Daily pipeline ${label} checkpoint is invalid`, 409);
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((candidate) => !candidate)) {
    throw new SignalError("DATABASE_WRITE_FAILED", `Daily pipeline ${label} checkpoint is incomplete`, 409);
  }
  return selected as CandidateSignal[];
}

export class BriefingGenerator {
  private readonly briefings: BriefingRepository;
  private readonly unifiedMemories: MemoryService;
  private readonly candidates: CollectionRepository;
  private readonly watches: WatchModule;

  constructor(private readonly env: Env, private readonly llm: SignalLLM) {
    this.briefings = new BriefingRepository(env.DB);
    this.unifiedMemories = new MemoryService(env.DB);
    this.candidates = new CollectionRepository(env.DB);
    this.watches = new WatchModule(env.DB);
  }

  fixture(): CandidateSignal[] {
    return fixtureCandidates.map((value) => parseCandidateSignal(fixtureCandidate(value as Parameters<typeof fixtureCandidate>[0])));
  }

  async generate(input: BriefingGenerationInput): Promise<GenerateBriefingResponse> {
    if (input.candidates.length === 0) throw new SignalError("INVALID_REQUEST", "At least one candidate is required", 400);
    const runId = input.runId ?? crypto.randomUUID();
    const briefingId = input.briefingId ?? crypto.randomUUID();
    if (input.briefingId) {
      try {
        return { runId, briefing: await this.briefings.getById(briefingId) };
      } catch (cause) {
        if (!(cause instanceof SignalError) || cause.code !== "BRIEFING_NOT_FOUND") throw cause;
      }
    }
    const startedAt = new Date().toISOString();
    await this.briefings.startRun({ id: runId, date: input.date, triggerType: input.triggerType ?? "manual", promptVersion: BRIEFING_PROMPT_VERSION,
      model: this.env.ZX_SIGNAL_LLM_LABEL, candidateCount: input.candidates.length, startedAt,
      collectionRunId: input.collectionRunId, stats: input.stats });
    try {
      const checkpoint: DailyPipelineCheckpoint = { ...input.checkpoint };
      let qualityDegraded = checkpoint.validatedDraft
        ? checkpoint.validatedDraft.qualityStatus === "degraded"
        : checkpoint.qualityDegraded ?? Boolean(input.sourceQualityDegraded);
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
      const memories = canonicalMemories.slice(0, 20);
      let synthesisCandidates = input.candidates;
      let storyDossiers = buildStoryDossiers(input.candidates);
      if (input.dataOrigin === "real") {
        const dateStart = Date.parse(`${input.date}T00:00:00.000Z`);
        const historySince = new Date(dateStart - HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
        const historyUntil = new Date(dateStart + 86_400_000).toISOString();
        const [historicalCandidates, priorCoverage] = await Promise.all([
          this.candidates.historicalCandidatesForContext({
            excludeCollectionRunId: input.collectionRunId,
            since: historySince,
            until: historyUntil,
          }),
          this.briefings.recentItemsBefore(input.date),
        ]);
        storyDossiers = buildStoryDossiers(input.candidates, historicalCandidates, priorCoverage);
        let decisions = checkpoint.editorialDecisions;
        if (!decisions) {
          await input.onStage?.("filtering");
          try {
            decisions = await this.llm.filterCandidates({ candidates: input.candidates, memories, storyDossiers, runId });
          } catch (cause) {
            const transient = transientModelFailure(cause);
            if (!transient) throw cause;
            decisions = deterministicEditorialFallback(input.candidates);
            qualityDegraded = true;
            console.warn(JSON.stringify({
              event: "signal.editorial_filter.fallback",
              runId,
              candidateCount: input.candidates.length,
              keptCount: decisions.filter((decision) => decision.decision === "keep").length,
              reason: transient instanceof GatewayRequestError ? transient.failureCode : transient.name,
            }));
          }
          await input.onCheckpoint?.({ editorialDecisions: decisions, qualityDegraded });
          checkpoint.editorialDecisions = decisions;
          checkpoint.qualityDegraded = qualityDegraded;
        }
        await this.candidates.saveEditorialDecisions(decisions);
        if (checkpoint.synthesisCandidateIds) {
          synthesisCandidates = candidatesFromCheckpoint(input.candidates, checkpoint.synthesisCandidateIds, "synthesis");
        } else {
          synthesisCandidates = selectSynthesisCandidates(input.candidates, decisions);
          await input.onCheckpoint?.({ synthesisCandidateIds: synthesisCandidates.map((candidate) => candidate.id) });
          checkpoint.synthesisCandidateIds = synthesisCandidates.map((candidate) => candidate.id);
        }
        if (synthesisCandidates.length === 0) throw new SignalError("NO_ELIGIBLE_CANDIDATES", "Editorial filter kept no candidates", 422);
        storyDossiers = selectStoryDossiers(storyDossiers, new Set(synthesisCandidates.map((candidate) => candidate.id)));
      }
      let draft: GeneratedBriefingDraft;
      let generationMode: "model" | "deterministic-fallback" = "model";
      if (checkpoint.validatedDraft) {
        generationMode = checkpoint.validatedDraft.generationMode;
        draft = parseGeneratedBriefingDraft(
          checkpoint.validatedDraft.draft,
          new Set(synthesisCandidates.map((candidate) => candidate.id)),
        );
        draft = assertEditionQuality({ draft, candidates: synthesisCandidates, storyDossiers });
      } else {
        await input.onStage?.("generating");
        try {
          draft = await this.llm.generateBriefing({ date: input.date, candidates: synthesisCandidates, memories, storyDossiers, runId });
        } catch (cause) {
          const transient = input.dataOrigin === "real" ? transientModelFailure(cause) : undefined;
          if (!transient) throw cause;
          const fallbackCandidates = selectUniqueEditionCandidates({
            candidates: synthesisCandidates,
            storyDossiers,
            limit: BRIEFING_FALLBACK_LIMIT,
          });
          if (fallbackCandidates.length === 0) {
            throw new SignalError("NO_ELIGIBLE_CANDIDATES", "No independent story remained for deterministic generation", 422);
          }
          const fallbackDossiers = selectStoryDossiers(storyDossiers, new Set(fallbackCandidates.map((candidate) => candidate.id)));
          synthesisCandidates = fallbackCandidates;
          storyDossiers = fallbackDossiers;
          await input.onCheckpoint?.({ synthesisCandidateIds: synthesisCandidates.map((candidate) => candidate.id) });
          checkpoint.synthesisCandidateIds = synthesisCandidates.map((candidate) => candidate.id);
          draft = deterministicBriefingFallback(input.date, fallbackCandidates);
          generationMode = "deterministic-fallback";
          qualityDegraded = true;
          console.warn(JSON.stringify({
            event: "signal.briefing.fallback",
            runId,
            candidateCount: synthesisCandidates.length,
            itemCount: draft.items.length,
            reason: transient instanceof GatewayRequestError ? transient.failureCode : transient.name,
          }));
        }
        await input.onStage?.("validating");
        draft = assertEditionQuality({ draft, candidates: synthesisCandidates, storyDossiers });
        const validatedDraft: NonNullable<DailyPipelineCheckpoint["validatedDraft"]> = {
          draft,
          generationMode,
          qualityStatus: qualityDegraded ? "degraded" : "passed",
        };
        await input.onCheckpoint?.({ validatedDraft });
        checkpoint.validatedDraft = validatedDraft;
      }
      const generatedAt = new Date().toISOString();
      await input.onStage?.("publishing");
      await this.briefings.saveGenerated({ runId, briefingId, date: input.date, draft, candidates: synthesisCandidates,
        promptVersion: BRIEFING_PROMPT_VERSION, model: this.env.ZX_SIGNAL_LLM_LABEL, dataOrigin: input.dataOrigin,
        generatedAt, linkCandidates: input.dataOrigin === "real", generationMode,
        qualityStatus: qualityDegraded ? "degraded" : "passed", synthesisCount: synthesisCandidates.length });
      const briefing = await this.briefings.getById(briefingId);
      try {
        await this.watches.observeBriefing(briefing);
      } catch (cause) {
        console.error(JSON.stringify({
          event: "signal.watch.observe_failed",
          briefingId,
          errorCode: cause instanceof SignalError ? cause.code : "WATCH_OBSERVATION_FAILED",
        }));
      }
      return { runId, briefing };
    } catch (cause) {
      const code = cause instanceof SignalError ? cause.code : "MODEL_REQUEST_FAILED";
      await this.briefings.failRun(runId, code);
      throw cause;
    }
  }
}
