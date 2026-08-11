import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { BriefingItem, CandidateSignal } from "@zxlab/signal-schema";
import { ProjectApiSignalLLM } from "../src/services/llm";

const item: BriefingItem = {
  id: "item-1",
  itemType: "lead",
  category: "zxlab",
  title: "Gateway migration",
  lede: "ZX Signal now uses the project gateway.",
  nutGraf: "The gateway centralizes provider policy.",
  keyFacts: ["Signal calls one project-owned endpoint."],
  broaderContext: "Provider configuration previously lived in multiple services.",
  implications: "One server-side model exit is easier to operate.",
  counterpoint: "The gateway remains a shared dependency.",
  watchNext: "Track fallback reliability.",
  summary: "ZX Signal now uses the project gateway.",
  whyItMatters: "One server-side model exit is easier to operate.",
  importance: 80,
  confidence: 90,
  sources: [{ id: "source-1", title: "Architecture note", url: "https://example.com/source" }],
};

function gatewayStream(data: unknown, requestId = "gateway-request-1", deltas: string[] = []): Response {
  const events = [
    { type: "start", requestId },
    { type: "attempt", requestId, provider: "provider1", model: "gpt-test", fallbackIndex: 0, attempt: 1 },
    ...deltas.map((text) => ({ type: "delta", requestId, text })),
    { type: "done", requestId, data },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

function briefingCandidate(id: string): CandidateSignal {
  return {
    id,
    source: { sourceId: `source-${id}`, sourceName: `Source ${id}`, sourceType: "rss", externalId: id },
    categoryHint: "ai-engineering",
    title: `Candidate ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    summary: `Summary for ${id}`,
    fetchedAt: "2026-08-07T00:00:00.000Z",
    tags: ["test"],
    contentHash: id,
    metadata: {},
    collectionRunId: "project-api-llm-test",
    status: "eligible",
  };
}

function briefingDraft(candidates: CandidateSignal[], count: number) {
  return {
    title: "Daily briefing",
    summary: "A valid test briefing.",
    longTermThreads: [],
    items: candidates.slice(0, count).map((candidate, index) => ({
      itemType: index === 0 ? "lead" : "brief",
      category: "ai-engineering",
      title: candidate.title,
      lede: candidate.summary,
      nutGraf: "The candidate has enough evidence for a concise briefing item.",
      keyFacts: ["A verifiable fact."],
      ...(index === 0 ? {
        broaderContext: "The lead anchors the full daily briefing.",
        counterpoint: "The evidence remains limited to the supplied sources.",
        watchNext: "Track the next verified development.",
      } : {}),
      implications: "The reader can evaluate the wider significance from the source.",
      importance: index === 0 ? 90 : 60,
      confidence: 80,
      sourceIds: [candidate.id],
    })),
  };
}

describe("ProjectApiSignalLLM", () => {
  it("calls the runtime fetch without rebinding its receiver", async () => {
    const runtimeFetch = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain("/api/ai/stream");
      return gatewayStream({
        text: JSON.stringify({ reply: "默认 fetch 路径可用。" }),
        json: { reply: "默认 fetch 路径可用。" },
        provider: "provider1",
        model: "gpt-test",
        fallbackIndex: 0,
        latencyMs: 8,
      }, "gateway-request-default-fetch");
    });
    vi.stubGlobal("fetch", runtimeFetch);
    try {
      const llm = new ProjectApiSignalLLM(env);
      await expect(llm.replyToAnnotation({
        item,
        selectedText: "runtime fetch",
        comment: "验证默认调用路径",
        action: "comment",
        memories: [],
      })).resolves.toEqual({ reply: "默认 fetch 路径可用。" });
      expect(runtimeFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("calls the project gateway and records the selected provider model", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("/api/ai/stream");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-gateway-token",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      });
      const body = JSON.parse(String(init?.body)) as { task: string; messages: Array<{ content: string }>; responseFormat: { type: string } };
      expect(body.task).toBe("signal-annotation-reply");
      expect(body.responseFormat).toEqual({ type: "json" });
      expect(body.messages[0]?.content).toContain("The output JSON must match this schema exactly");
      return gatewayStream({
        text: JSON.stringify({ reply: "已通过项目网关生成。" }),
        json: { reply: "已通过项目网关生成。" },
        provider: "provider1",
        model: "gpt-test",
        fallbackIndex: 0,
        latencyMs: 12,
        usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
      });
    });
    const llm = new ProjectApiSignalLLM(env, fetcher);
    const result = await llm.replyToAnnotation({
      item,
      selectedText: "project gateway",
      comment: "确认统一出口是否生效",
      action: "comment",
      memories: [],
    });

    expect(result).toEqual({ reply: "已通过项目网关生成。" });
    expect(fetcher).toHaveBeenCalledOnce();
    const invocation = await env.DB.prepare(`SELECT status, model, input_tokens, output_tokens
      FROM model_invocations ORDER BY started_at DESC LIMIT 1`).first<{
        status: string; model: string; input_tokens: number; output_tokens: number;
      }>();
    expect(invocation).toEqual({
      status: "succeeded",
      model: "provider1/gpt-test",
      input_tokens: 40,
      output_tokens: 8,
    });
  });

  it("streams annotation reply deltas from the gateway JSON field", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => gatewayStream({
      text: JSON.stringify({ reply: "流式回应已经可见。" }),
      json: { reply: "流式回应已经可见。" },
      provider: "provider1",
      model: "gpt-test",
      fallbackIndex: 0,
      latencyMs: 10,
    }, "gateway-stream-reply", [
      "{\"reply\":\"流式",
      "回应已经",
      "可见。\"}",
    ]));
    const llm = new ProjectApiSignalLLM(env, fetcher);
    let streamed = "";
    const result = await llm.replyToAnnotation({
      item,
      selectedText: "project gateway",
      comment: "确认回复是否流式出现",
      action: "comment",
      memories: [],
    }, { onDelta: (text) => { streamed += text; } });

    expect(result).toEqual({ reply: "流式回应已经可见。" });
    expect(streamed).toBe("流式回应已经可见。");
  });

  it("resets a partial annotation reply before streaming the provider fallback", async () => {
    const finalReply = { reply: "回退后的完整回复。" };
    const events = [
      { type: "start", requestId: "gateway-stream-reset" },
      { type: "delta", requestId: "gateway-stream-reset", text: '{"reply":"错误的半截' },
      { type: "reset", requestId: "gateway-stream-reset", reason: "fallback" },
      { type: "delta", requestId: "gateway-stream-reset", text: '{"reply":"回退后的' },
      { type: "delta", requestId: "gateway-stream-reset", text: '完整回复。"}' },
      {
        type: "done",
        requestId: "gateway-stream-reset",
        data: {
          text: JSON.stringify(finalReply),
          json: finalReply,
          provider: "provider2",
          model: "gpt-fallback",
          fallbackIndex: 1,
          latencyMs: 18,
        },
      },
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ));
    const llm = new ProjectApiSignalLLM(env, fetcher);
    let streamed = "";

    const result = await llm.replyToAnnotation({
      item,
      selectedText: "project gateway",
      comment: "确认 provider fallback 会清除旧输出",
      action: "comment",
      memories: [],
    }, {
      onDelta: (text) => { streamed += text; },
      onReset: () => { streamed = ""; },
    });

    expect(result).toEqual(finalReply);
    expect(streamed).toBe(finalReply.reply);
  });

  it("repairs a full daily briefing that returns fewer than ten items", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => briefingCandidate(`daily-${index + 1}`));
    const runId = "daily-minimum-test";
    const startedAt = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at)
      VALUES (?, '2026-08-07', 'running', 'manual', 'test', 'test', ?)`)
      .bind(runId, startedAt).run();
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toContain('"minItems":10');
      const draft = briefingDraft(candidates, attempt === 0 ? 9 : 10);
      attempt += 1;
      return gatewayStream({
        text: JSON.stringify(draft),
        json: draft,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        fallbackIndex: 0,
        latencyMs: 10,
      }, `gateway-daily-${attempt}`);
    });
    const llm = new ProjectApiSignalLLM(env, fetcher);
    const result = await llm.generateBriefing({
      date: "2026-08-07",
      candidates,
      memories: [],
      storyDossiers: [],
      runId,
    });

    expect(result.items).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("holds a briefing when repeated candidate sources survive the single repair attempt", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => briefingCandidate(`quality-${index + 1}`));
    const runId = "daily-quality-hold-test";
    await env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at)
      VALUES (?, '2026-08-10', 'running', 'manual', 'test', 'test', ?)`)
      .bind(runId, new Date().toISOString()).run();
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      const repeated = briefingDraft(candidates, 10);
      repeated.items[1]!.sourceIds = [candidates[0]!.id];
      attempt += 1;
      return gatewayStream({
        text: JSON.stringify(repeated),
        json: repeated,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        fallbackIndex: 0,
        latencyMs: 10,
      }, `gateway-quality-${attempt}`);
    });
    const llm = new ProjectApiSignalLLM(env, fetcher);

    await expect(llm.generateBriefing({
      date: "2026-08-10",
      candidates,
      memories: [],
      storyDossiers: [],
      runId,
    })).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("holds a briefing when the single repair request fails transiently", async () => {
    const candidates = Array.from({ length: 10 }, (_, index) => briefingCandidate(`repair-failure-${index + 1}`));
    const runId = "daily-repair-transient-hold-test";
    await env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at)
      VALUES (?, '2026-08-11', 'running', 'manual', 'test', 'test', ?)`)
      .bind(runId, new Date().toISOString()).run();
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      attempt += 1;
      if (attempt === 1) {
        const repeated = briefingDraft(candidates, 10);
        repeated.items[1]!.sourceIds = [candidates[0]!.id];
        return gatewayStream({
          text: JSON.stringify(repeated),
          json: repeated,
          provider: "deepseek",
          model: "deepseek-v4-flash",
          fallbackIndex: 0,
          latencyMs: 10,
        }, "gateway-repair-invalid-first-pass");
      }
      return new Response(
        'event: error\ndata: {"type":"error","requestId":"gateway-repair-transient","error":{"code":"ALL_CANDIDATES_FAILED"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const llm = new ProjectApiSignalLLM(env, fetcher);

    await expect(llm.generateBriefing({
      date: "2026-08-11",
      candidates,
      memories: [],
      storyDossiers: [],
      runId,
    })).rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
