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
});
