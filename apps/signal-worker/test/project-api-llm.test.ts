import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { BriefingItem } from "@zxlab/signal-schema";
import { ProjectApiSignalLLM } from "../src/services/llm";

const item: BriefingItem = {
  id: "item-1",
  category: "zxlab",
  title: "Gateway migration",
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
});
