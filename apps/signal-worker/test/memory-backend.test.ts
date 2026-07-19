import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryConsolidationService } from "../src/memory/consolidation/service";
import { UnifiedMemoryRepository } from "../src/memory/repository/memory-repository";
import { MemoryService } from "../src/memory/service/memory-service";

async function clearMemory(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memory_consolidation_candidates"),
    env.DB.prepare("DELETE FROM feedback_events"),
    env.DB.prepare("DELETE FROM memory_revisions"),
    env.DB.prepare("DELETE FROM memory_items"),
  ]);
}

function gatewayStream(data: unknown): Response {
  const requestId = "test-request";
  const events = [
    { type: "start", requestId },
    { type: "done", requestId, data },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

describe("unified memory backend", () => {
  beforeEach(clearMemory);

  it("ranks active namespace memory within the token budget", async () => {
    const service = new MemoryService(env.DB);
    await service.create({ namespace: "briefing", kind: "preference", content: "用户不关注纯融资新闻。", importance: 0.9, confidence: 0.9, sourceType: "test" });
    await service.create({ namespace: "coding", kind: "decision", content: "TypeScript should use strict mode.", importance: 1, confidence: 1, sourceType: "test" });

    const result = await service.retrieve({ task: "signal-briefing", namespaces: ["briefing"], query: "筛选融资新闻", limit: 5, tokenBudget: 128 });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.namespace).toBe("briefing");
    expect(result.summary).toContain("纯融资新闻");
    expect(result.tokenEstimate).toBeLessThanOrEqual(128);
  });

  it("writes a revision for updates and soft-forgets", async () => {
    const service = new MemoryService(env.DB);
    const repository = new UnifiedMemoryRepository(env.DB);
    const created = await service.create({ namespace: "zxlab", kind: "decision", content: "Use edge-compatible storage.", importance: 0.8, confidence: 0.9, sourceType: "manual" });
    await service.update(created.id, { content: "Use D1 for relational edge storage.", reason: "Architecture clarified" });
    const forgotten = await service.forget(created.id, "No longer applicable");
    const revisions = await repository.revisions(created.id);

    expect(forgotten.status).toBe("forgotten");
    expect(revisions).toHaveLength(2);
    expect(revisions.map((item) => item.reason)).toEqual(expect.arrayContaining(["Architecture clarified", "No longer applicable"]));
    expect(await repository.activeItems(["zxlab"])).toHaveLength(0);
  });

  it("stores feedback without changing memory and requires candidate acceptance", async () => {
    const repository = new UnifiedMemoryRepository(env.DB);
    const feedback = await repository.createEvent({ targetType: "briefing_item", targetId: "funding-1", action: "dislike", comment: "这类纯融资新闻没有产品进展" });
    expect(await repository.activeItems()).toHaveLength(0);

    const fetcher: typeof fetch = async (input) => {
      expect(String(input)).toContain("/api/ai/stream");
      return gatewayStream({
        text: "{}",
        json: { candidates: [{ action: "create", reason: "Explicit durable signal", namespace: "briefing", kind: "preference", content: "用户通常不关注只有融资金额的新闻。", importance: 0.7, confidence: 0.72, sourceEventIds: [feedback.id] }] },
        provider: "test", model: "test-model", fallbackIndex: 0, latencyMs: 1, usage: { inputTokens: 10, outputTokens: 20 },
      });
    };
    const consolidation = new MemoryConsolidationService(env, fetcher);
    const candidates = await consolidation.generate(10);
    expect(candidates).toHaveLength(1);
    expect(await repository.activeItems()).toHaveLength(0);

    const accepted = await consolidation.accept(candidates[0]!.id);
    expect(accepted.memory?.content).toContain("融资金额");
    expect(await repository.activeItems(["briefing"])).toHaveLength(1);
  });
});
