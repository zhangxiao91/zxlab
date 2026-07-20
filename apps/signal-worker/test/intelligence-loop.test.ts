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
      items: [{
        category: "ai-engineering",
        title: "Agent toolkit runtime fit",
        summary: "TEST MATERIAL. Candidate framework comparison.",
        whyItMatters: hasWorkersMemory
          ? "Cloudflare Worker runtime 仅能迁移可移植的编排逻辑；child_process 等 Node.js API、常驻进程和本地文件系统假设不兼容，需要把 checkpoint 迁移到 D1 或 Durable Objects。"
          : "需要先验证这个工具是否适合 zxlab。",
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

    const annotationId = crypto.randomUUID();
    const candidateId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO annotations (id, briefing_id, briefing_item_id, selected_text, comment, action_type, created_at)
        VALUES (?, ?, ?, ?, ?, 'remember', ?)`)
        .bind(annotationId, first.briefing.id, first.briefing.items[0]?.id, "runtime fit", "我更关心它能否在 Cloudflare Workers 限制下运行。", now),
      env.DB.prepare(`INSERT INTO memory_candidates
        (id, annotation_id, proposed_scope, scope_key, content, confidence, reason, status, created_at, resolved_at)
        VALUES (?, ?, 'project', 'zxlab', ?, 0.95, ?, 'accepted', ?, ?)`)
        .bind(candidateId, annotationId, "评估 zxlab 可采用的新工具时，优先检查 Cloudflare Workers 兼容性。", "用户明确提出项目运行约束", now, now),
      env.DB.prepare(`INSERT INTO memory_entries
        (id, scope, scope_key, content, confidence, status, created_at, updated_at, last_confirmed_at)
        VALUES (?, 'project', 'zxlab', ?, 0.95, 'active', ?, ?, ?)`)
        .bind(crypto.randomUUID(), "评估 zxlab 可采用的新工具时，优先检查 Cloudflare Workers 兼容性。", now, now, now),
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
      title: "Invalid", summary: "Invalid source", items: [{ category: "zxlab", title: "Bad", summary: "Bad",
        whyItMatters: "Bad", importance: 50, confidence: 50, sourceIds: ["invented-source"] }],
    }, new Set(["fixture-node-framework"]))).toThrow(/unknown source/);
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
