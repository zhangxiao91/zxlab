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
import { CollectionRepository } from "../src/repositories/collection-repository";
import { SignalError } from "../src/lib/errors";
import { GatewayRequestError } from "../src/services/gateway-client";
import { findSource } from "../src/config/sources";
import type { BriefingGenerationInput } from "../src/services/briefing-generator";
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

class TransientPipelineFailureLLM extends TransientEditorialFailureLLM {
  override async generateBriefing(): Promise<never> {
    throw new SignalError(
      "MODEL_REQUEST_FAILED",
      "The model request failed",
      502,
      new GatewayRequestError("GATEWAY_502_ALL_CANDIDATES_FAILED", "Project AI gateway failed with ALL_CANDIDATES_FAILED"),
    );
  }
}

class InvalidBriefingLLM extends PipelineLLM {
  override async generateBriefing(): Promise<never> {
    throw new SignalError(
      "INVALID_MODEL_OUTPUT",
      "The single model repair attempt did not produce a publishable briefing",
      400,
      new SignalError(
        "MODEL_REQUEST_FAILED",
        "The model request failed",
        502,
        new GatewayRequestError("GATEWAY_STREAM_ALL_CANDIDATES_FAILED", "Project AI gateway failed with ALL_CANDIDATES_FAILED"),
      ),
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

  it("caps release notes and changelogs at two before the model pass", () => {
    const selected = selectBalancedDailyCandidates([
      ...Array.from({ length: 8 }, (_, index) => candidate(`release-${index}`, "ai-engineering", `a-release-source-${index}`, "github-release")),
      ...Array.from({ length: 9 }, (_, index) => candidate(`news-${index}`, "ai-engineering", `z-news-source-${index}`)),
      ...Array.from({ length: 4 }, (_, index) => candidate(`market-${index}`, "markets", `market-source-${index}`)),
    ], 12);
    expect(selected).toHaveLength(12);
    expect(selected.filter((item) => item.source.sourceType === "github-release")).toHaveLength(2);
  });

  it("does not pad a narrow day with additional release notes", () => {
    const selected = selectBalancedDailyCandidates(
      Array.from({ length: 12 }, (_, index) => candidate(`release-${index}`, "ai-engineering", `release-source-${index}`, "web-changelog")),
      12,
    );
    expect(selected).toHaveLength(2);
  });

  it("does not let a capped release hide later reporting from the same family", () => {
    const selected = selectBalancedDailyCandidates([
      candidate("first-release", "ai-engineering", "a-release-family", "github-release"),
      candidate("hf-release", "ai-engineering", "github-huggingface-transformers-releases", "github-release"),
      candidate("hf-paper", "ai-engineering", "hf-daily-papers", "hf-daily-papers"),
      candidate("independent-news", "ai-engineering", "z-independent-news", "rss"),
    ], 3);

    expect(selected.map((item) => item.id)).toEqual(["first-release", "hf-paper", "independent-news"]);
  });

  it("applies the family cap across configured sibling feeds", () => {
    const selected = selectBalancedDailyCandidates([
      ...Array.from({ length: 4 }, (_, index) => candidate(`linuxdo-develop-${index}`, "ai-engineering", "linuxdo-develop")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`linuxdo-news-${index}`, "ai-engineering", "linuxdo-news")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`mit-${index}`, "ai-engineering", "mit-technology-review")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`verge-${index}`, "ai-engineering", "the-verge-ai")),
      ...Array.from({ length: 4 }, (_, index) => candidate(`hn-${index}`, "ai-engineering", "hn-ai-engineering")),
    ], 12);

    expect(selected).toHaveLength(12);
    expect(selected.filter((item) => item.source.sourceId.startsWith("linuxdo-"))).toHaveLength(3);
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

  it("passes honest collection-run counters and marks unavailable submitted-set stages", async () => {
    const repository = new CollectionRepository(env.DB);
    const source = findSource("mit-technology-review")!;
    const now = "2026-08-10T01:00:00.000Z";
    await repository.syncSources([source], now);
    await repository.createRun("manual-provenance-run", "manual", 2, now);
    await repository.persistCandidate({
      ...candidate("manual-provenance", "ai-engineering", source.id),
      collectionRunId: "manual-provenance-run",
    });
    await repository.finalizeRun("manual-provenance-run", {
      successSources: 1,
      failedSources: 1,
      fetched: 17,
      inserted: 1,
      duplicates: 16,
      errors: ["one source failed"],
    });

    const captured: BriefingGenerationInput[] = [];
    const briefingGenerator = {
      fixture: () => [candidate("fixture-provenance", "zxlab")],
      generate: async (input: BriefingGenerationInput) => {
        captured.push(input);
        return {} as never;
      },
    };
    const collectionResponse = await handleAdmin(new Request("https://signal.example/api/admin/briefings/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateMode: "collection-run", collectionRunId: "manual-provenance-run", maxCandidates: 1 }),
    }), "/api/admin/briefings/generate", env, { briefingGenerator });
    const customCandidate = candidate("custom-provenance", "markets");
    const customResponse = await handleAdmin(new Request("https://signal.example/api/admin/briefings/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: [customCandidate] }),
    }), "/api/admin/briefings/generate", env, { briefingGenerator });
    const fixtureResponse = await handleAdmin(new Request("https://signal.example/api/admin/briefings/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateMode: "fixture" }),
    }), "/api/admin/briefings/generate", env, { briefingGenerator });

    expect([collectionResponse?.status, customResponse?.status, fixtureResponse?.status]).toEqual([201, 201, 201]);
    expect(captured[0]).toMatchObject({
      collectionRunId: "manual-provenance-run",
      sourceQualityDegraded: true,
      stats: { fetched: 17, unique: 1, balanced: 1 },
    });
    expect(captured[1]?.stats).toEqual({ fetched: null, unique: null, balanced: 1 });
    expect(captured[2]?.stats).toEqual({ fetched: null, unique: null, balanced: 1 });
    const storedSource = await env.DB.prepare("SELECT source_family, config_json FROM signal_sources WHERE id = ?")
      .bind(source.id).first<{ source_family: string; config_json: string }>();
    expect(storedSource?.source_family).toBe("mit-technology-review");
    expect(JSON.parse(storedSource!.config_json)).toMatchObject({ family: "mit-technology-review" });
  });

  it("hydrates pre-provenance briefings with explicit unknown legacy markers", async () => {
    await env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, completed_at,
       candidate_count, selected_count, error_code, error_message, collection_run_id)
      VALUES (?, ?, 'succeeded', 'manual', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
      .bind("legacy-briefing-run", "2026-08-09", "legacy-prompt", "legacy-model",
        "2026-08-09T00:00:00.000Z", "2026-08-09T00:01:00.000Z", 7, 0).run();
    await env.DB.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at,
       prompt_version, model, supersedes_id)
      VALUES (?, ?, ?, ?, ?, 'ready', 1, 'real', ?, ?, ?, NULL)`)
      .bind("legacy-briefing", "legacy-briefing-run", "2026-08-09", "Legacy briefing", "Legacy summary",
        "2026-08-09T00:01:00.000Z", "legacy-prompt", "legacy-model").run();

    const hydrated = await new BriefingRepository(env.DB).getById("legacy-briefing");
    expect(hydrated).toMatchObject({
      generationMode: "legacy-unknown",
      qualityStatus: "unknown",
      stats: { fetched: null, deduplicated: null, balanced: null, synthesized: null, selected: 0 },
    });
  });

  it("rejects admin publication from an unfinished collection run", async () => {
    const repository = new CollectionRepository(env.DB);
    await repository.createRun("unfinished-collection-run", "manual", 1, "2026-08-10T02:00:00.000Z");
    const briefingGenerator = {
      fixture: () => [],
      generate: async () => { throw new Error("generator should not be called"); },
    };

    await expect(handleAdmin(new Request("https://signal.example/api/admin/briefings/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateMode: "collection-run", collectionRunId: "unfinished-collection-run" }),
    }), "/api/admin/briefings/generate", env, { briefingGenerator })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 409,
    });
  });

  it("collects, filters and persists the active briefing for the Shanghai day", async () => {
    const collectors = new Map<SignalSourceType, SignalCollector>([["rss", collector]]);
    const collection = new CollectionService(env, collectors);
    const pipeline = new DailySignalPipeline(env, collection, new PipelineLLM());
    const result = await pipeline.run(Date.parse("2026-07-18T23:30:00.000Z"), {
      sourceIds: ["mit-technology-review"],
    });

    const briefing = await env.DB.prepare("SELECT briefings.briefing_date, briefings.data_origin, briefing_runs.collection_run_id FROM briefings JOIN briefing_runs ON briefing_runs.id = briefings.run_id WHERE briefings.id = ?")
      .bind(result.briefingId).first<{ briefing_date: string; data_origin: string; collection_run_id: string }>();
    expect(briefing).toEqual({
      briefing_date: "2026-07-19",
      data_origin: "real",
      collection_run_id: result.collectionRunId,
    });
    const hydrated = await new BriefingRepository(env.DB).getById(result.briefingId);
    expect(hydrated).toMatchObject({
      generationMode: "model",
      qualityStatus: "passed",
      stats: { fetched: 1, deduplicated: 1, balanced: 1, synthesized: 1, selected: 1 },
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
      sourceIds: ["mit-technology-review"],
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

  it("persists a source-backed briefing when every transient model request fails", async () => {
    const fallbackCollector: SignalCollector = {
      type: "rss",
      async collect() {
        return [{
          externalId: "scheduled-briefing-fallback",
          title: "Workers adds deterministic recovery controls",
          url: "https://developers.cloudflare.com/changelog/scheduled-briefing-fallback",
          summary: "Operators can recover scheduled workloads without losing the source trail.",
          publishedAt: "2026-07-30T22:00:00.000Z",
        }];
      },
    };
    const collectors = new Map<SignalSourceType, SignalCollector>([["rss", fallbackCollector]]);
    const collection = new CollectionService(env, collectors);
    const pipeline = new DailySignalPipeline(env, collection, new TransientPipelineFailureLLM());

    const result = await pipeline.run(Date.parse("2026-07-30T23:30:00.000Z"), {
      sourceIds: ["mit-technology-review"],
    });

    const run = await env.DB.prepare("SELECT status, selected_count FROM briefing_runs WHERE id = ?")
      .bind(result.briefingRunId).first<{ status: string; selected_count: number }>();
    const briefing = await env.DB.prepare("SELECT status, briefing_date FROM briefings WHERE id = ?")
      .bind(result.briefingId).first<{ status: string; briefing_date: string }>();
    const item = await env.DB.prepare(`SELECT i.item_type, i.title, s.url, bic.candidate_signal_id
      FROM briefing_items i
      JOIN briefing_sources s ON s.item_id = i.id
      JOIN briefing_item_candidates bic ON bic.briefing_item_id = i.id
      WHERE i.briefing_id = ?`)
      .bind(result.briefingId).first<{ item_type: string; title: string; url: string; candidate_signal_id: string }>();

    expect(run).toEqual({ status: "succeeded", selected_count: 1 });
    expect(briefing).toEqual({ status: "ready", briefing_date: "2026-07-31" });
    expect(item).toMatchObject({
      item_type: "lead",
      title: "Workers adds deterministic recovery controls",
      url: "https://developers.cloudflare.com/changelog/scheduled-briefing-fallback",
    });
    expect(item?.candidate_signal_id).toBeTruthy();
    const hydrated = await new BriefingRepository(env.DB).getById(result.briefingId);
    expect(hydrated).toMatchObject({
      generationMode: "deterministic-fallback",
      qualityStatus: "degraded",
      stats: { fetched: 1, deduplicated: 1, balanced: 1, synthesized: 1, selected: 1 },
    });
  });

  it("does not mask invalid briefing output with the deterministic fallback", async () => {
    const invalidOutputCollector: SignalCollector = {
      type: "rss",
      async collect() {
        return [{
          externalId: "invalid-briefing-output",
          title: "Invalid briefing output test",
          url: "https://developers.cloudflare.com/changelog/invalid-briefing-output",
          summary: "A candidate that reaches the briefing validation boundary.",
          publishedAt: "2026-07-31T22:00:00.000Z",
        }];
      },
    };
    const collectors = new Map<SignalSourceType, SignalCollector>([["rss", invalidOutputCollector]]);
    const collection = new CollectionService(env, collectors);
    const pipeline = new DailySignalPipeline(env, collection, new InvalidBriefingLLM());

    await expect(pipeline.run(Date.parse("2026-07-31T23:30:00.000Z"), {
      sourceIds: ["mit-technology-review"],
    })).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });
});
