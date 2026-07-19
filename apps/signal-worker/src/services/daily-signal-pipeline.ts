import type { CandidateSignal, SignalCategory, StartCollectionRequest } from "@zxlab/signal-schema";
import { CollectionRepository } from "../repositories/collection-repository";
import { BriefingGenerator } from "./briefing-generator";
import { CollectionService } from "./collection-service";
import { ProjectApiSignalLLM, type SignalLLM } from "./llm";

const DAILY_CANDIDATE_POOL = 40;
const DAILY_MAX_CANDIDATES = 24;
const BALANCE_ORDER: SignalCategory[] = ["ai-engineering", "markets", "zxlab", "uncategorized"];

export function selectBalancedDailyCandidates(candidates: CandidateSignal[], maxCandidates = DAILY_MAX_CANDIDATES): CandidateSignal[] {
  const buckets = new Map<SignalCategory, CandidateSignal[]>();
  for (const category of BALANCE_ORDER) buckets.set(category, []);
  for (const candidate of candidates) buckets.get(candidate.categoryHint)?.push(candidate);

  const selected: CandidateSignal[] = [];
  const seen = new Set<string>();
  while (selected.length < maxCandidates) {
    let added = false;
    for (const category of BALANCE_ORDER) {
      const candidate = buckets.get(category)?.shift();
      if (!candidate || seen.has(candidate.id)) continue;
      selected.push(candidate);
      seen.add(candidate.id);
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
  ): Promise<{ collectionRunId: string; briefingId: string; briefingRunId: string }> {
    const collection = await this.collection.run(collectionRequest, {
      triggerType: "workflow",
      now: new Date(scheduledTime).toISOString(),
    });
    if (collection.status === "failed" || collection.successSourceCount === 0) {
      throw new Error(`Signal collection ${collection.id} did not produce a usable source run`);
    }

    const candidates = await new CollectionRepository(this.env.DB).candidatesForBriefing({
      collectionRunId: collection.id,
      maxCandidates: DAILY_CANDIDATE_POOL,
    });
    const balancedCandidates = selectBalancedDailyCandidates(candidates);
    const generated = await new BriefingGenerator(this.env, this.llm).generate({
      date: shanghaiDate(scheduledTime),
      candidates: balancedCandidates,
      dataOrigin: "real",
      collectionRunId: collection.id,
    });
    return {
      collectionRunId: collection.id,
      briefingId: generated.briefing.id,
      briefingRunId: generated.runId,
    };
  }
}
