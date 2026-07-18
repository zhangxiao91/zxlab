import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AnnotationReplyDraft,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
} from "@zxlab/signal-schema";
import { parseGeneratedBriefingDraft } from "@zxlab/signal-schema";
import { BriefingGenerator } from "../src/services/briefing-generator";
import type {
  AnnotationReplyInput,
  GenerateBriefingInput,
  MemoryExtractionInput,
  SignalLLM,
} from "../src/services/llm";

class MemoryAwareFixtureLLM implements SignalLLM {
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
});
