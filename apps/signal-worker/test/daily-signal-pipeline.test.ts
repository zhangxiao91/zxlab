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
import { handleAdmin } from "../src/routes/admin";
import { BriefingRepository } from "../src/repositories/briefing-repository";
import { SignalError } from "../src/lib/errors";
import { GatewayRequestError } from "../src/services/gateway-client";
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

function candidate(
  id: string,
  categoryHint: SignalCategory,
  sourceId = `source-${id}`,
  sourceType: SignalSourceType = "rss",
): CandidateSignal {
  return {
    id,
    source: { sourceId, sourceName: `Source ${sourceId}`, sourceType, externalId: id },
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
      longTermThreads: [],
      items: [{
        itemType: "lead",
        category: "zxlab",
        title: candidate.title,
        lede: candidate.summary ?? candidate.title,
        nutGraf: "定时采集产生了一条可验证的主报道。",
        keyFacts: ["scheduled handler 完成采集与筛选。"],
        broaderContext: "该测试覆盖从来源采集到日报持久化的完整路径。",
        implications: "证明 scheduled handler 可以从采集批次生成真实日报。",
        counterpoint: "测试模型不评价真实新闻质量。",
        watchNext: "确认生产定时任务采用相同合同。",
        importance: 80,
        confidence: 90,
        sourceIds: [candidate.id],
      }],
    };
  }

  async replyToAnnotation(_input: AnnotationReplyInput): Promise<AnnotationReplyDraft> { return { reply: "unused" }; }
  async extractMemory(_input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> { return null; }
}

class TransientEditorialFailureLLM extends PipelineLLM {
  override async filterCandidates(): Promise<never> {
    throw new SignalError(
      "MODEL_REQUEST_FAILED",
      "The model request failed",
      502,
      new GatewayRequestError("GATEWAY_502_ALL_CANDIDATES_FAILED", "Project AI gateway failed with ALL_CANDIDATES_FAILED"),
    );
  }
}

describe("Daily Signal pipeline", () => {
  it("runs the complete pipeline and refreshes Pages through the admin recovery route", async () => {
    const calls: string[] = [];
    const response = await handleAdmin(
      new Request("https://signal.example/api/admin/pipeline/run", { method: "POST" }),
      "/api/admin/pipeline/run",
      env,
      {
        now: () => Date.parse("2026-07-27T00:55:00.000Z"),
        runPipeline: async (scheduledTime) => {
          calls.push(`pipeline:${scheduledTime}`);
          return { collectionRunId: "collection-run", briefingId: "briefing", briefingRunId: "briefing-run" };
        },
        refreshPages: async () => {
          calls.push("pages");
          return "triggered";
        },
      },
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const responseBody = response ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    expect(responseBody.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { status: "accepted", startedAt: "2026-07-27T00:55:00.000Z" },
      {
        status: "succeeded",
        collectionRunId: "collection-run",
        briefingId: "briefing",
        briefingRunId: "briefing-run",
        pagesRefresh: "triggered",
      },
    ]);
    expect(calls).toEqual([`pipeline:${Date.parse("2026-07-27T00:55:00.000Z")}`, "pages"]);
  });

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

  it("caps release notes and changelogs at one quarter of the candidate pool", () => {
    const selected = selectBalancedDailyCandidates([
      ...Array.from({ length: 8 }, (_, index) => candidate(`release-${index}`, "ai-engineering", `a-release-source-${index}`, "github-release")),
      ...Array.from({ length: 9 }, (_, index) => candidate(`news-${index}`, "ai-engineering", `z-news-source-${index}`)),
      ...Array.from({ length: 4 }, (_, index) => candidate(`market-${index}`, "markets", `market-source-${index}`)),
    ], 12);
    expect(selected).toHaveLength(12);
    expect(selected.filter((item) => item.source.sourceType === "github-release")).toHaveLength(3);
  });

  it("does not pad a narrow day with additional release notes", () => {
    const selected = selectBalancedDailyCandidates(
      Array.from({ length: 12 }, (_, index) => candidate(`release-${index}`, "ai-engineering", `release-source-${index}`, "web-changelog")),
      12,
    );
    expect(selected).toHaveLength(3);
  });

  it("exposes failed briefing and model invocation diagnostics", async () => {
    const repository = new BriefingRepository(env.DB);
    await repository.startRun({ id: "briefing-diagnostic", date: "2026-07-19", triggerType: "workflow", promptVersion: "test", model: "test-model", candidateCount: 24, startedAt: "2026-07-19T00:00:00.000Z" });
    await env.DB.prepare(`INSERT INTO model_invocations (id, task, run_id, model, prompt_version, status, started_at, completed_at, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind("invocation-diagnostic", "editorial-filter", "briefing-diagnostic", "test-model", "test", "failed", "2026-07-19T00:00:01.000Z", "2026-07-19T00:00:02.000Z", "GATEWAY_STREAM_PROVIDER_UNAVAILABLE").run();
    await repository.failRun("briefing-diagnostic", "MODEL_REQUEST_FAILED", "The model request failed");
    const diagnostic = (await repository.latestDiagnostics()).find((run) => run.id === "briefing-diagnostic");
    expect(diagnostic).toMatchObject({ status: "failed", candidateCount: 24, errorCode: "MODEL_REQUEST_FAILED" });
    expect(diagnostic?.invocations).toMatchObject([{ task: "editorial-filter", errorCode: "GATEWAY_STREAM_PROVIDER_UNAVAILABLE" }]);
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

  it("continues with an auditable deterministic shortlist when the editorial gateway is temporarily unavailable", async () => {
    const fallbackCollector: SignalCollector = {
      type: "rss",
      async collect() {
        return [{
          externalId: "scheduled-editorial-fallback",
          title: "Scheduled editorial fallback test",
          url: "https://developers.cloudflare.com/changelog/scheduled-editorial-fallback",
          summary: "A candidate that reaches the deterministic editorial fallback.",
          publishedAt: "2026-07-29T22:00:00.000Z",
        }];
      },
    };
    const collectors = new Map<SignalSourceType, SignalCollector>([["rss", fallbackCollector]]);
    const collection = new CollectionService(env, collectors);
    const pipeline = new DailySignalPipeline(env, collection, new TransientEditorialFailureLLM());

    const result = await pipeline.run(Date.parse("2026-07-29T23:30:00.000Z"), {
      sourceIds: ["cloudflare-developer-platform"],
    });

    const run = await env.DB.prepare("SELECT status, selected_count FROM briefing_runs WHERE id = ?")
      .bind(result.briefingRunId).first<{ status: string; selected_count: number }>();
    const decision = await env.DB.prepare("SELECT editorial_decision, editorial_reason FROM candidate_signals WHERE collection_run_id = ?")
      .bind(result.collectionRunId).first<{ editorial_decision: string; editorial_reason: string }>();
    expect(run).toEqual({ status: "succeeded", selected_count: 1 });
    expect(decision).toEqual({
      editorial_decision: "keep",
      editorial_reason: "Deterministic fallback after a temporary editorial gateway failure.",
    });
  });
});
