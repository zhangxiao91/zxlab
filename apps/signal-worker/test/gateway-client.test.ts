import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, requestGatewayJson } from "../src/services/gateway-client";

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

  it("does not retry the full request when streaming exhausts the provider chain", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response(
        'event: error\ndata: {"type":"error","requestId":"request-1","error":{"code":"ALL_CANDIDATES_FAILED"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ));

    const request = requestGatewayJson({
      fetcher,
      apiUrl: "https://gateway.example/api/ai/generate",
      token: "token",
      invocationId: "invocation-1",
      body: { task: "signal-briefing" },
    });

    await expect(request).rejects.toEqual(expect.objectContaining<Partial<GatewayRequestError>>({
      failureCode: "GATEWAY_STREAM_ALL_CANDIDATES_FAILED",
    }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://gateway.example/api/ai/stream",
    ]);
  });

  it("clears partial deltas when the stream resets before a provider fallback", async () => {
    const events = [
      { type: "start", requestId: "request-reset" },
      { type: "delta", requestId: "request-reset", text: "{broken" },
      { type: "reset", requestId: "request-reset", reason: "fallback" },
      { type: "delta", requestId: "request-reset", text: '{"answer":42}' },
      {
        type: "done",
        requestId: "request-reset",
        data: {
          text: '{"answer":42}',
          json: { answer: 42 },
          provider: "provider",
          model: "model",
          fallbackIndex: 1,
          latencyMs: 12,
        },
      },
    ];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ));
    let partial = "";

    const result = await requestGatewayJson({
      fetcher,
      apiUrl: "https://gateway.example/api/ai/generate",
      token: "token",
      invocationId: "invocation-reset",
      body: { task: "signal-briefing" },
      onDelta: (text) => { partial += text; },
      onReset: () => { partial = ""; },
    });

    expect(partial).toBe('{"answer":42}');
    expect(result.data.fallbackIndex).toBe(1);
  });
});
