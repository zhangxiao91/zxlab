import { describe, expect, it, vi } from "vitest";
import { requestGatewayJson } from "../src/services/gateway-client";

describe("gateway client", () => {
  it("falls back to the generate endpoint when the stream times out", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        requestId: "request-1",
        data: {
          text: "{}",
          json: {},
          provider: "provider",
          model: "model",
          fallbackIndex: 0,
          latencyMs: 10,
        },
      }));

    const result = await requestGatewayJson({
      fetcher,
      apiUrl: "https://gateway.example/api/ai/generate",
      token: "token",
      invocationId: "invocation-1",
      body: { task: "signal-briefing" },
    });

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://gateway.example/api/ai/stream",
      "https://gateway.example/api/ai/generate",
    ]);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("falls back to the generate endpoint when streaming exhausts the provider chain", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        'event: error\ndata: {"type":"error","requestId":"request-1","error":{"code":"ALL_CANDIDATES_FAILED"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        requestId: "request-1",
        data: {
          text: "{\"ok\":true}",
          json: { ok: true },
          provider: "deepseek",
          model: "deepseek-v4-flash",
          fallbackIndex: 0,
          latencyMs: 10,
        },
      }));

    const result = await requestGatewayJson({
      fetcher,
      apiUrl: "https://gateway.example/api/ai/generate",
      token: "token",
      invocationId: "invocation-1",
      body: { task: "signal-briefing" },
    });

    expect(result.data.provider).toBe("deepseek");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://gateway.example/api/ai/stream",
      "https://gateway.example/api/ai/generate",
    ]);
  });
});
