import type { CandidateSignal, SignalCategory, StartCollectionRequest } from "@zxlab/signal-schema";
import { CollectionRepository } from "../repositories/collection-repository";
import { BriefingGenerator } from "./briefing-generator";
import { CollectionService } from "./collection-service";
import { ProjectApiSignalLLM, type SignalLLM } from "./llm";
import { signalSourcePolicy } from "./source-policy";
import { SignalError } from "../lib/errors";
import { SIGNAL_SOURCES } from "../config/sources";

export const DAILY_CANDIDATE_POOL = SIGNAL_SOURCES.reduce((total, source) => total + source.maxItemsPerRun, 0);
const DAILY_MAX_CANDIDATES = 12;
const BALANCE_ORDER: SignalCategory[] = ["ai-engineering", "markets", "zxlab", "uncategorized"];

export function isReleaseNoteCandidate(candidate: CandidateSignal): boolean {
  return signalSourcePolicy.isReleaseNote(candidate);
}

export function selectBalancedDailyCandidates(candidates: CandidateSignal[], maxCandidates = DAILY_MAX_CANDIDATES): CandidateSignal[] {
  const buckets = new Map<SignalCategory, Map<string, CandidateSignal[]>>();
  const familyQuotas = new Map<string, number>();
  for (const category of BALANCE_ORDER) buckets.set(category, new Map());
  for (const candidate of candidates) {
    const classification = signalSourcePolicy.classify(candidate);
    if (!classification.dailyEligible || classification.dailyCandidateQuota < 1) continue;
    const category = buckets.get(candidate.categoryHint);
    if (!category) continue;
    const family = classification.family;
    familyQuotas.set(family, Math.min(
      familyQuotas.get(family) ?? classification.dailyCandidateQuota,
      classification.dailyCandidateQuota,
    ));
    const source = category.get(family) ?? [];
    source.push(candidate);
    category.set(family, source);
  }

  const selected: CandidateSignal[] = [];
  const seen = new Set<string>();
  const familyCounts = new Map<string, number>();
  const releaseNoteLimit = signalSourcePolicy.releaseNoteLimit(maxCandidates);
  let releaseNoteCount = 0;
  const takeFromCategory = (category: SignalCategory): boolean => {
    const sources = buckets.get(category);
    if (!sources) return false;
    const choice = [...sources.entries()]
      .flatMap(([family, items]) => {
        if ((familyCounts.get(family) ?? 0) >= (familyQuotas.get(family) ?? 3)) return [];
        const nextIndex = items.findIndex((candidate) => !seen.has(candidate.id)
          && (!isReleaseNoteCandidate(candidate) || releaseNoteCount < releaseNoteLimit));
        return nextIndex < 0 ? [] : [{ family, items, nextIndex }];
      })
      .sort((left, right) => (familyCounts.get(left.family) ?? 0) - (familyCounts.get(right.family) ?? 0)
        || left.family.localeCompare(right.family))[0];
    if (!choice) return false;
    const { family, items, nextIndex } = choice;
    const [candidate] = items.splice(nextIndex, 1);
    if (!candidate || seen.has(candidate.id)) return false;
    selected.push(candidate);
    seen.add(candidate.id);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    if (isReleaseNoteCandidate(candidate)) releaseNoteCount += 1;
    return true;
  };

  while (selected.length < maxCandidates) {
    let added = false;
    for (const category of BALANCE_ORDER) {
      if (!takeFromCategory(category)) continue;
      added = true;
      if (selected.length >= maxCandidates) break;
    }
    if (!added) break;
  }
  return selected;
}

function shanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export class DailySignalPipeline {
  constructor(
    private readonly env: Env,
    private readonly collection = new CollectionService(env),
    private readonly llm: SignalLLM = new ProjectApiSignalLLM(env),
  ) {}

  async run(
    scheduledTime = Date.now(),
    collectionRequest: StartCollectionRequest = {},
    options: {
      collectionRunId?: string;
      briefingRunId?: string;
      briefingId?: string;
      onStage?: (stage: import("./daily-pipeline-runner").DailyPipelineStage) => Promise<void>;
      onCollectionReady?: (collectionRunId: string) => Promise<void>;
      checkpoint?: import("./daily-pipeline-runner").DailyPipelineCheckpoint;
      onCheckpoint?: (checkpoint: Partial<import("./daily-pipeline-runner").DailyPipelineCheckpoint>) => Promise<void>;
    } = {},
  ): Promise<{ collectionRunId: string; briefingId: string; briefingRunId: string }> {
    let collection;
    if (options.collectionRunId) {
      try {
        collection = await new CollectionRepository(this.env.DB).getRun(options.collectionRunId);
        if (collection.status === "running" || collection.status === "failed") {
          await options.onStage?.("collecting");
          collection = await this.collection.run(collectionRequest, {
            runId: options.collectionRunId,
            triggerType: "workflow",
            now: new Date(scheduledTime).toISOString(),
          });
          await options.onCollectionReady?.(collection.id);
        }
      } catch (cause) {
        if (!(cause instanceof SignalError) || cause.code !== "COLLECTION_RUN_NOT_FOUND") throw cause;
        await options.onStage?.("collecting");
        collection = await this.collection.run(collectionRequest, {
          runId: options.collectionRunId,
          triggerType: "workflow",
          now: new Date(scheduledTime).toISOString(),
        });
        await options.onCollectionReady?.(collection.id);
      }
    } else {
      await options.onStage?.("collecting");
      collection = await this.collection.run(collectionRequest, {
        triggerType: "workflow",
        now: new Date(scheduledTime).toISOString(),
      });
      await options.onCollectionReady?.(collection.id);
    }
    if (collection.status === "failed" || collection.successSourceCount === 0) {
      throw new Error(`Signal collection ${collection.id} did not produce a usable source run`);
    }

    await options.onStage?.("normalizing");
    const repository = new CollectionRepository(this.env.DB);
    const uniqueCandidateCount = await repository.countCandidatesForBriefing({ collectionRunId: collection.id });
    let balancedCandidates: CandidateSignal[];
    if (options.checkpoint?.candidateIds) {
      balancedCandidates = await repository.candidatesByIds(options.checkpoint.candidateIds, collection.id);
    } else {
      const candidates = await repository.candidatesForBriefing({
        collectionRunId: collection.id,
        maxCandidates: DAILY_CANDIDATE_POOL,
      });
      balancedCandidates = selectBalancedDailyCandidates(candidates);
      await options.onCheckpoint?.({ candidateIds: balancedCandidates.map((candidate) => candidate.id) });
    }
    const generated = await new BriefingGenerator(this.env, this.llm).generate({
      date: shanghaiDate(scheduledTime),
      candidates: balancedCandidates,
      dataOrigin: "real",
      collectionRunId: collection.id,
      triggerType: "workflow",
      sourceQualityDegraded: collection.status === "partial",
      stats: {
        fetched: collection.fetchedCount,
        unique: uniqueCandidateCount,
        balanced: balancedCandidates.length,
      },
      onStage: options.onStage,
      runId: options.briefingRunId,
      briefingId: options.briefingId,
      checkpoint: options.checkpoint,
      onCheckpoint: options.onCheckpoint,
    });
    return {
      collectionRunId: collection.id,
      briefingId: generated.briefing.id,
      briefingRunId: generated.runId,
    };
  }
}
