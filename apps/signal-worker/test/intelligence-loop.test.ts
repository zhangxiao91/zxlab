import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AnnotationReplyDraft,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
} from "@zxlab/signal-schema";
import { parseGeneratedBriefingDraft } from "@zxlab/signal-schema";
import { handleAnnotations } from "../src/routes/annotations";
import { BriefingGenerator } from "../src/services/briefing-generator";
import type {
  AnnotationReplyInput,
  EditorialFilterInput,
  GenerateBriefingInput,
  MemoryExtractionInput,
  SignalLLM,
} from "../src/services/llm";

class MemoryAwareFixtureLLM implements SignalLLM {
  async filterCandidates(input: EditorialFilterInput): Promise<never> {
    throw new Error(`Unexpected editorial filter for fixture run ${input.runId}`);
  }

  async generateBriefing(input: GenerateBriefingInput): Promise<GeneratedBriefingDraft> {
    const hasWorkersMemory = input.memories.some((memory) => /Cloudflare Workers/i.test(memory.content));
    return {
      title: hasWorkersMemory ? "运行约束改变了工具判断" : "工具能力需要进一步验证",
      summary: hasWorkersMemory ? "已确认的 zxlab 项目约束被用于重新评估同一候选。" : "这是未注入项目记忆时的基线日报。",
      longTermThreads: [
        { id: "thread-runtime-fit", title: "Agent 运行边界", description: "持续验证 Agent 框架的运行时与恢复约束。", category: "ai-engineering", dossierIds: ["fixture-runtime"] },
        { id: "thread-evaluation", title: "真实任务评测", description: "跟踪工具变化是否改善真实任务轨迹。", category: "zxlab", dossierIds: ["fixture-evaluation"] },
      ],
      items: [{
        itemType: "lead",
        category: "ai-engineering",
        title: "Agent toolkit runtime fit",
        lede: "TEST MATERIAL. Candidate framework comparison.",
        nutGraf: "The fixture checks whether confirmed memory changes analysis.",
        keyFacts: ["The candidate assumes a full Node.js runtime."],
        broaderContext: "Runtime constraints determine whether orchestration code is portable.",
        implications: hasWorkersMemory
          ? "Cloudflare Worker runtime 仅能迁移可移植的编排逻辑；child_process 等 Node.js API、常驻进程和本地文件系统假设不兼容，需要把 checkpoint 迁移到 D1 或 Durable Objects。"
          : "需要先验证这个工具是否适合 zxlab。",
        counterpoint: "Some orchestration logic may remain portable behind an adapter.",
        watchNext: "Test the runtime adapter before adoption.",
        importance: 90,
        confidence: 85,
        sourceIds: ["fixture-node-framework"],
      }],
    };
  }

  async replyToAnnotation(_input: AnnotationReplyInput): Promise<AnnotationReplyDraft> {
    return { reply: "Test reply" };
  }

  async extractMemory(_input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> {
    return null;
  }
}

class StreamingAnnotationFixtureLLM extends MemoryAwareFixtureLLM {
  override async replyToAnnotation(_input: AnnotationReplyInput, options: { onDelta?: (text: string) => void } = {}): Promise<AnnotationReplyDraft> {
    options.onDelta?.("先看到");
    options.onDelta?.("流式回复。");
    return { reply: "先看到流式回复。" };
  }

  override async extractMemory(_input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> {
    return { shouldRemember: true, scope: "project", content: "用户在验证 Signal 前端流式体验。", confidence: 0.81, reason: "用户明确指出前端仍是一次性出现" };
  }
}

async function streamEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const raw = await response.text();
  return raw.trim().split(/\n\n+/).map((chunk) => {
    const data = chunk.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    if (!data) throw new Error("Missing SSE data line");
    return JSON.parse(data) as Record<string, unknown>;
  });
}

describe("ZX Signal intelligence loop", () => {
  it("injects accepted project memory and observably changes the next briefing", async () => {
    const generator = new BriefingGenerator(env, new MemoryAwareFixtureLLM());
    const candidates = generator.fixture();
    const date = "2026-07-18";

    const first = await generator.generate({ date, candidates, dataOrigin: "fixture" });
    expect(first.briefing.items[0]?.whyItMatters).toBe("需要先验证这个工具是否适合 zxlab。");
    expect(first.briefing.longTermThreads.map((thread) => thread.id)).toEqual(["thread-runtime-fit", "thread-evaluation"]);

    const annotationId = crypto.randomUUID();
    const candidateId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO annotations (id, briefing_id, briefing_item_id, selected_text, comment, action_type, created_at)
        VALUES (?, ?, ?, ?, ?, 'remember', ?)`)
        .bind(annotationId, first.briefing.id, first.briefing.items[0]?.id, "runtime fit", "我更关心它能否在 Cloudflare Workers 限制下运行。", now),
      env.DB.prepare(`INSERT INTO memory_consolidation_candidates
        (id, action, reason, namespace, kind, content, importance, confidence, source_event_ids_json, status, created_at, resolved_at)
        VALUES (?, 'create', ?, 'zxlab', 'decision', ?, 0.95, 0.95, ?, 'accepted', ?, ?)`)
        .bind(candidateId, "用户明确提出项目运行约束", "评估 zxlab 可采用的新工具时，优先检查 Cloudflare Workers 兼容性。", JSON.stringify([annotationId]), now, now),
      env.DB.prepare(`INSERT INTO memory_items
        (id, namespace, kind, content, importance, confidence, source_type, source_id, status, created_at, updated_at)
        VALUES (?, 'zxlab', 'decision', ?, 0.95, 0.95, 'annotation', ?, 'active', ?, ?)`)
        .bind(crypto.randomUUID(), "评估 zxlab 可采用的新工具时，优先检查 Cloudflare Workers 兼容性。", annotationId, now, now),
    ]);

    const second = await generator.generate({ date, candidates, dataOrigin: "fixture" });
    const analysis = second.briefing.items[0]?.whyItMatters ?? "";
    expect(second.briefing.id).not.toBe(first.briefing.id);
    expect(analysis).toContain("Worker runtime");
    expect(analysis).toContain("Node.js API");
    expect(analysis).toContain("常驻进程");
    expect(analysis).toContain("本地文件系统");
    expect(analysis).toContain("迁移");

    const oldVersion = await env.DB.prepare("SELECT is_active, status FROM briefings WHERE id = ?").bind(first.briefing.id).first<{ is_active: number; status: string }>();
    expect(oldVersion).toEqual({ is_active: 0, status: "superseded" });
  });

  it("rejects model output that references a source outside the candidate set", () => {
    expect(() => parseGeneratedBriefingDraft({
      title: "Invalid", summary: "Invalid source", items: [{ itemType: "lead", category: "zxlab", title: "Bad", lede: "Bad",
        nutGraf: "Bad", keyFacts: ["Bad"], broaderContext: "Bad", implications: "Bad", counterpoint: "Bad", watchNext: "Bad",
        importance: 50, confidence: 50, sourceIds: ["invented-source"] }],
    }, new Set(["fixture-node-framework"]))).toThrow(/unknown source/);
  });

  it("requires exactly one fully developed lead story at the start", () => {
    const sourceIds = new Set(["fixture-node-framework"]);
    const base = {
      category: "zxlab",
      title: "Signal becomes a newsroom",
      lede: "The briefing now separates one lead story from concise briefs.",
      nutGraf: "The hierarchy makes significance visible before implementation detail.",
      keyFacts: ["One story leads the edition."],
      implications: "Readers receive context before project-specific advice.",
      importance: 90,
      confidence: 85,
      sourceIds: ["fixture-node-framework"],
    };
    expect(() => parseGeneratedBriefingDraft({
      title: "Invalid order", summary: "A brief cannot lead.", items: [{ ...base, itemType: "brief" }],
    }, sourceIds)).toThrow(/exactly one lead/);
    expect(() => parseGeneratedBriefingDraft({
      title: "Shallow lead", summary: "The lead lacks required depth.", items: [{ ...base, itemType: "lead" }],
    }, sourceIds)).toThrow(/broaderContext/);
  });

  it("keeps two to four evidenced long-term threads without failing the briefing", () => {
    const sourceIds = new Set(["fixture-node-framework"]);
    const dossierIds = new Set(["dossier-1", "dossier-2", "dossier-3", "dossier-4", "dossier-5"]);
    const lead = {
      itemType: "lead", category: "zxlab", title: "A durable lead", lede: "A durable lead lede.",
      nutGraf: "The lead establishes significance.", keyFacts: ["One supported fact."], broaderContext: "Historical context.",
      implications: "The implications are material.", counterpoint: "The evidence remains incomplete.", watchNext: "Track the next confirmed event.",
      importance: 90, confidence: 85, sourceIds: ["fixture-node-framework"],
    };
    const thread = (index: number, dossierId = `dossier-${index}`) => ({
      title: `Recurring theme ${index}`, description: `Track the confirmed condition for theme ${index}.`,
      category: "zxlab", dossierIds: [dossierId],
    });
    const parsed = parseGeneratedBriefingDraft({
      title: "Threaded briefing", summary: "Recurring themes are separated from today's stories.",
      longTermThreads: [thread(1), thread(2, "unknown-dossier"), thread(3), thread(4), thread(5)], items: [lead],
    }, sourceIds, dossierIds);
    expect(parsed.longTermThreads).toHaveLength(3);
    expect(parsed.longTermThreads.map((item) => item.dossierIds[0])).toEqual(["dossier-1", "dossier-3", "dossier-4"]);
    expect(new Set(parsed.longTermThreads.map((item) => item.id)).size).toBe(3);

    const fallback = parseGeneratedBriefingDraft({
      title: "Fallback briefing", summary: "Only one thread survived validation.",
      longTermThreads: [thread(1), thread(2, "unknown-dossier")], items: [lead],
    }, sourceIds, dossierIds);
    expect(fallback.longTermThreads).toEqual([]);
  });

  it("streams annotation replies before the final memory candidate", async () => {
    const llm = new StreamingAnnotationFixtureLLM();
    const generated = await new BriefingGenerator(env, llm).generate({ date: "2026-07-18", candidates: new BriefingGenerator(env, llm).fixture(), dataOrigin: "fixture" });
    const item = generated.briefing.items[0]!;
    const request = new Request("https://signal.example/api/annotations?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        briefingId: generated.briefing.id,
        briefingItemId: item.id,
        selectedText: "runtime fit",
        comment: "请验证这条回复是否能逐段出现",
        action: "comment",
      }),
    });

    const response = await handleAnnotations(request, "/api/annotations", env, { llm });
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const events = await streamEvents(response!);

    expect(events.map((event) => event.type)).toEqual(["start", "reply_delta", "reply_delta", "reply", "memory", "done"]);
    expect(events.filter((event) => event.type === "reply_delta").map((event) => event.text).join("")).toBe("先看到流式回复。");
    const done = events.at(-1)?.response as { reply?: { content?: string }; memoryCandidate?: { content?: string } };
    expect(done.reply?.content).toBe("先看到流式回复。");
    expect(done.memoryCandidate?.content).toContain("前端流式体验");
  });
});
