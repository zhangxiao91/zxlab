import type { CandidateSignal, SignalCategory, StartCollectionRequest } from "@zxlab/signal-schema";
import { CollectionRepository } from "../repositories/collection-repository";
import { BriefingGenerator } from "./briefing-generator";
import { CollectionService } from "./collection-service";
import { ProjectApiSignalLLM, type SignalLLM } from "./llm";

const DAILY_CANDIDATE_POOL = 200;
const DAILY_MAX_CANDIDATES = 24;
const BALANCE_ORDER: SignalCategory[] = ["ai-engineering", "markets", "zxlab", "uncategorized"];
const MAX_CANDIDATES_PER_SOURCE = 3;

export function selectBalancedDailyCandidates(candidates: CandidateSignal[], maxCandidates = DAILY_MAX_CANDIDATES): CandidateSignal[] {
  const buckets = new Map<SignalCategory, Map<string, CandidateSignal[]>>();
  for (const category of BALANCE_ORDER) buckets.set(category, new Map());
  for (const candidate of candidates) {
    const category = buckets.get(candidate.categoryHint);
    if (!category) continue;
    const source = category.get(candidate.source.sourceId) ?? [];
    source.push(candidate);
    category.set(candidate.source.sourceId, source);
  }

  const selected: CandidateSignal[] = [];
  const seen = new Set<string>();
  const sourceCounts = new Map<string, number>();
  const takeFromCategory = (category: SignalCategory, enforceSourceCap: boolean): boolean => {
    const sources = buckets.get(category);
    if (!sources) return false;
    const choice = [...sources.entries()]
      .filter(([sourceId, items]) => items.length > 0 && (!enforceSourceCap || (sourceCounts.get(sourceId) ?? 0) < MAX_CANDIDATES_PER_SOURCE))
      .sort(([leftId], [rightId]) => (sourceCounts.get(leftId) ?? 0) - (sourceCounts.get(rightId) ?? 0) || leftId.localeCompare(rightId))[0];
    if (!choice) return false;
    const [sourceId, items] = choice;
    const candidate = items.shift();
    if (!candidate || seen.has(candidate.id)) return false;
    selected.push(candidate);
    seen.add(candidate.id);
    sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1);
    return true;
  };

  for (const enforceSourceCap of [true, false]) {
    while (selected.length < maxCandidates) {
      let added = false;
      for (const category of BALANCE_ORDER) {
        if (!takeFromCategory(category, enforceSourceCap)) continue;
        added = true;
        if (selected.length >= maxCandidates) break;
      }
      if (!added) break;
    }
    if (selected.length >= maxCandidates) break;
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
