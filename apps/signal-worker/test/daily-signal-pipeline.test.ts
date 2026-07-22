import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AnnotationReplyDraft,
  CandidateSignal,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
  SignalCategory,
  SignalSourceType,
} from "@zxlab/signal-schema";
import type { SignalCollector } from "../src/collectors/types";
import { CollectionService } from "../src/services/collection-service";
import { DailySignalPipeline, selectBalancedDailyCandidates } from "../src/services/daily-signal-pipeline";
import type {
  AnnotationReplyInput,
  EditorialFilterInput,
  GenerateBriefingInput,
  MemoryExtractionInput,
  SignalLLM,
} from "../src/services/llm";

const collector: SignalCollector = {
  type: "rss",
  async collect() {
    return [{
      externalId: "scheduled-release",
      title: "Scheduled Workers runtime update",
      url: "https://developers.cloudflare.com/changelog/scheduled-release",
      summary: "A scheduled pipeline test candidate.",
      publishedAt: "2026-07-18T22:00:00.000Z",
    }];
  },
};

function candidate(id: string, categoryHint: SignalCategory, sourceId = `source-${id}`): CandidateSignal {
  return {
    id,
    source: { sourceId, sourceName: `Source ${sourceId}`, sourceType: "rss", externalId: id },
    categoryHint,
    title: `Candidate ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    summary: `Summary ${id}`,
    fetchedAt: "2026-07-18T22:00:00.000Z",
    tags: [],
    contentHash: `hash-${id}`,
    metadata: {},
    collectionRunId: "balanced-test",
    status: "eligible",
  };
}

class PipelineLLM implements SignalLLM {
  async filterCandidates(input: EditorialFilterInput) {
    return input.candidates.map((candidate) => ({
      candidateId: candidate.id,
      decision: "keep" as const,
      category: candidate.categoryHint,
      relevance: 90,
      novelty: 80,
      actionability: 70,
      sourceQuality: 90,
      reason: "Suitable for the scheduled briefing.",
      relatedMemoryIds: [],
    }));
  }

  async generateBriefing(input: GenerateBriefingInput): Promise<GeneratedBriefingDraft> {
    const candidate = input.candidates[0]!;
    return {
      title: "每日自动 Signal",
      summary: "定时采集与生成链路已完成。",
      items: [{
        category: "zxlab",
        title: candidate.title,
        summary: candidate.summary ?? candidate.title,
        whyItMatters: "证明 scheduled handler 可以从采集批次生成真实日报。",
        importance: 80,
        confidence: 90,
        sourceIds: [candidate.id],
      }],
    };
  }

  async replyToAnnotation(_input: AnnotationReplyInput): Promise<AnnotationReplyDraft> { return { reply: "unused" }; }
  async extractMemory(_input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> { return null; }
}

describe("Daily Signal pipeline", () => {
  it("balances daily candidates across categories before the LLM pass", () => {
    const selected = selectBalancedDailyCandidates([
      candidate("ai-1", "ai-engineering"),
      candidate("ai-2", "ai-engineering"),
      candidate("ai-3", "ai-engineering"),
      candidate("market-1", "markets"),
      candidate("zxlab-1", "zxlab"),
      candidate("market-2", "markets"),
    ], 5);
    expect(selected.map((item) => item.categoryHint)).toEqual(["ai-engineering", "markets", "zxlab", "ai-engineering", "markets"]);
  });

  it("limits a prolific source before falling back to it", () => {
    const selected = selectBalancedDailyCandidates([
      ...Array.from({ length: 8 }, (_, index) => candidate(`cloudflare-${index}`, "zxlab", "cloudflare")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`openai-${index}`, "ai-engineering", "openai")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`market-${index}`, "markets", "market")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`research-${index}`, "ai-engineering", "research")),
    ], 12);
    expect(selected.filter((item) => item.source.sourceId === "cloudflare")).toHaveLength(3);
    expect(new Set(selected.map((item) => item.source.sourceId))).toEqual(new Set(["cloudflare", "openai", "market", "research"]));
  });

  it("collects, filters and persists the active briefing for the Shanghai day", async () => {
    const collectors = new Map<SignalSourceType, SignalCollector>([["rss", collector]]);
    const collection = new CollectionService(env, collectors);
    const pipeline = new DailySignalPipeline(env, collection, new PipelineLLM());
    const result = await pipeline.run(Date.parse("2026-07-18T23:30:00.000Z"), {
      sourceIds: ["cloudflare-developer-platform"],
    });

    const briefing = await env.DB.prepare("SELECT briefings.briefing_date, briefings.data_origin, briefing_runs.collection_run_id FROM briefings JOIN briefing_runs ON briefing_runs.id = briefings.run_id WHERE briefings.id = ?")
      .bind(result.briefingId).first<{ briefing_date: string; data_origin: string; collection_run_id: string }>();
    expect(briefing).toEqual({
      briefing_date: "2026-07-19",
      data_origin: "real",
      collection_run_id: result.collectionRunId,
    });
  });
});
