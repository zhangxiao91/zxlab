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

describe("ProjectApiSignalLLM", () => {
  it("calls the runtime fetch without rebinding its receiver", async () => {
    const runtimeFetch = vi.fn<typeof fetch>(async () => Response.json({
      ok: true,
      data: {
        text: JSON.stringify({ reply: "默认 fetch 路径可用。" }),
        json: { reply: "默认 fetch 路径可用。" },
        provider: "provider1",
        model: "gpt-test",
        fallbackIndex: 0,
        latencyMs: 8,
      },
      requestId: "gateway-request-default-fetch",
    }));
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
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-gateway-token",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(String(init?.body)) as { task: string; messages: Array<{ content: string }>; responseFormat: { type: string } };
      expect(body.task).toBe("signal-annotation-reply");
      expect(body.responseFormat).toEqual({ type: "json" });
      expect(body.messages[0]?.content).toContain("The output JSON must match this schema exactly");
      return Response.json({
        ok: true,
        data: {
          text: JSON.stringify({ reply: "已通过项目网关生成。" }),
          json: { reply: "已通过项目网关生成。" },
          provider: "provider1",
          model: "gpt-test",
          fallbackIndex: 0,
          latencyMs: 12,
          usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        },
        requestId: "gateway-request-1",
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
});
