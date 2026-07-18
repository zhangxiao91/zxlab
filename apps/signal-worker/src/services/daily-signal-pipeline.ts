import type { StartCollectionRequest } from "@zxlab/signal-schema";
import { CollectionRepository } from "../repositories/collection-repository";
import { BriefingGenerator } from "./briefing-generator";
import { CollectionService } from "./collection-service";
import { ProjectApiSignalLLM, type SignalLLM } from "./llm";

const DAILY_MAX_CANDIDATES = 8;

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
      maxCandidates: DAILY_MAX_CANDIDATES,
    });
    const generated = await new BriefingGenerator(this.env, this.llm).generate({
      date: shanghaiDate(scheduledTime),
      candidates,
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
