import assert from "node:assert/strict";
import test from "node:test";
import { handleHoldingsParseDraft } from "../functions/api/holdings/parse-draft.ts";
import { brokerSnapshotFromDraft, normalizeHoldingParseDraft, parseLocalHoldingText } from "../src/features/risk/holdings-parser.ts";

function gatewayStream(data: unknown, requestId = "holdings-gateway-1"): Response {
  const events = [
    { type: "start", requestId },
    { type: "attempt", requestId, provider: "provider1", model: "gpt", fallbackIndex: 0, attempt: 1 },
    { type: "done", requestId, data },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

test("holdings parser normalizes codes, preserves low-confidence warnings, and creates broker snapshot", () => {
  const draft = normalizeHoldingParseDraft({
    snapshotAt: "2026-07-20 15:01:00",
    accountName: "券商普通账户",
    sourceKind: "csv",
    positions: [
      { rawSymbol: "512480", rawName: "半导体ETF", quantity: "10000", averageCost: "0.92", confidence: 0.91, warnings: [] },
      { rawSymbol: "not-a-code", quantity: "3 手", averageCost: null, confidence: 0.2, warnings: ["单位疑似为手"] },
    ],
    unresolvedRows: [{ rowNumber: 4, raw: "foo", reason: "缺少代码" }],
    warnings: ["人工确认前不得写账本"],
  }, { sourceKind: "csv" });
  assert.equal(draft.positions[0].instrumentId, "SSE:512480");
  assert.equal(draft.positions[0].quantity, 10000);
  assert.equal(draft.positions[1].instrumentId, null);
  assert.ok(draft.positions[1].warnings.includes("无法确认交易所前缀"));
  const snapshot = brokerSnapshotFromDraft(draft, "2026-07-20T08:00:00.000Z");
  assert.equal(snapshot.positions.length, 1);
  assert.deepEqual(snapshot.positions[0], { instrumentId: "SSE:512480", quantity: 10000, averageCost: 0.92 });
  assert.equal(snapshot.rawDraftWarnings.some((item) => item.includes("第 4 行未解析")), true);
});

test("local holdings parser handles simple CSV and isolates unresolved rows", () => {
  const draft = parseLocalHoldingText("证券代码,证券名称,持仓数量,成本价\n512480,半导体ETF,10000,0.92\nbad,未知,10,1.2", "csv", "2026-07-20T08:00:00.000Z");
  assert.equal(draft.snapshotAt, "2026-07-20T08:00:00.000Z");
  assert.equal(draft.positions.length, 1);
  assert.equal(draft.positions[0].instrumentId, "SSE:512480");
  assert.equal(draft.unresolvedRows.length, 1);
});

test("holdings parse API prefers stream gateway and returns normalized draft", async () => {
  const requestedPaths: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requestedPaths.push(new URL(String(input)).pathname);
    return gatewayStream({
      json: {
        snapshotAt: "2026-07-20T15:00:00+08:00",
        accountName: "真实账户",
        sourceKind: "text",
        positions: [{ rawSymbol: "SZ159995", rawName: "芯片ETF", quantity: 2000, averageCost: 1.12, confidence: 0.88, warnings: [] }],
        unresolvedRows: [],
        warnings: [],
      },
      text: "{}",
      provider: "provider1",
      model: "gpt",
      fallbackIndex: 0,
      latencyMs: 42,
    });
  };
  const request = new Request("https://beta.zxlab.pages.dev/api/holdings/parse-draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceKind: "text", text: "159995 芯片ETF 2000 成本 1.12" }) });
  const response = await handleHoldingsParseDraft({ request, env: { AI_GATEWAY_ACCESS_TOKEN: "server-secret" } }, { verifyAccess: async () => ({}), fetcher });
  const payload = await response.json() as { ok: boolean; data: { positions: Array<{ instrumentId: string }>; provider: string; requestId: string } };
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.positions[0].instrumentId, "SZSE:159995");
  assert.equal(payload.data.provider, "provider1");
  assert.equal(payload.data.requestId, "holdings-gateway-1");
  assert.deepEqual(requestedPaths, ["/api/ai/stream"]);
});

test("holdings parse API falls back to local parser when gateway is unavailable after access", async () => {
  const request = new Request("https://beta.zxlab.pages.dev/api/holdings/parse-draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceKind: "csv", text: "证券代码,证券名称,持仓数量,成本价\n513100,纳指ETF,3000,1.3" }) });
  const response = await handleHoldingsParseDraft({ request, env: { AI_GATEWAY_ACCESS_TOKEN: "server-secret" } }, { verifyAccess: async () => ({}), fetcher: async () => Response.json({ ok: false, error: { code: "DOWN", message: "down" }, requestId: "ai-1" }, { status: 502 }) });
  const payload = await response.json() as { ok: boolean; data: { positions: Array<{ instrumentId: string }>; warnings: string[] } };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.positions[0].instrumentId, "SSE:513100");
  assert.match(payload.data.warnings[0], /LLM 持仓解析暂不可用/);
});
