import assert from "node:assert/strict";
import test from "node:test";
import { handleHoldingsParseDraft } from "../functions/api/holdings/parse-draft.ts";
import { LocalPortfolioRepository } from "../src/features/risk/ledger.ts";
import { brokerSnapshotFromDraft, normalizeHoldingParseDraft, parseLocalHoldingText } from "../src/features/risk/holdings-parser.ts";
import { previewLocalPortfolioSnapshot } from "../src/features/market-agent/portfolio-snapshot.ts";

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

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
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
  assert.equal(snapshot.instrumentMetadata?.[0]?.id, "SSE:512480");
  assert.equal(snapshot.rawDraftWarnings.some((item) => item.includes("第 4 行未解析")), true);
});

test("holdings parser preserves arbitrary exchange-listed instruments", () => {
  const draft = parseLocalHoldingText("证券代码,证券名称,持仓数量,成本价\nSSE:603156,养元饮品,1000,20.5", "csv", "2026-08-07T08:00:00.000Z");
  const snapshot = brokerSnapshotFromDraft(draft, "2026-08-07T08:00:01.000Z");
  assert.equal(draft.positions[0]?.instrumentId, "SSE:603156");
  assert.equal(snapshot.positions[0]?.instrumentId, "SSE:603156");
  assert.equal(snapshot.instrumentMetadata?.[0]?.name, "养元饮品");
});

test("local holdings parser handles simple CSV and isolates unresolved rows", () => {
  const draft = parseLocalHoldingText("证券代码,证券名称,持仓数量,成本价\n512480,半导体ETF,10000,0.92\nbad,未知,10,1.2", "csv", "2026-07-20T08:00:00.000Z");
  assert.equal(draft.snapshotAt, "2026-07-20T08:00:00.000Z");
  assert.equal(draft.positions.length, 1);
  assert.equal(draft.positions[0].instrumentId, "SSE:512480");
  assert.equal(draft.unresolvedRows.length, 1);
});

test("portfolio snapshot exporter whitelists only confirmed structured fields and blocks unsafe local state", () => {
  const repository = new LocalPortfolioRepository(memoryStorage());
  const now = Date.parse("2026-08-07T08:00:00.000Z");
  repository.saveBrokerSnapshot({
    id: "confirmed-snapshot-1",
    snapshotAt: "2026-08-07T07:30:00.000Z",
    accountName: "账户名称不得上传",
    sourceKind: "csv",
    importedAt: "2026-08-07T07:31:00.000Z",
    positions: [{ instrumentId: "SSE:603156", quantity: 1000, averageCost: 20.5 }],
    instrumentMetadata: [{ id: "SSE:603156", symbol: "603156", name: "养元饮品", assetClass: "股票", market: "A股", theme: "消费", beta: 1 }],
    rawDraftWarnings: ["原始行和自由文本不得上传"],
  });

  const preview = previewLocalPortfolioSnapshot(repository, now);
  assert.ok(preview.upload);
  assert.deepEqual(
    Object.keys(preview.upload).sort(),
    [
      "calculatedAt",
      "cash",
      "effectiveAt",
      "expiresAt",
      "positions",
      "rulesVersion",
      "schemaVersion",
      "sourceRevision",
    ],
  );
  assert.deepEqual(preview.upload.positions, [
    { instrumentId: "SSE:603156", quantity: 1000, averageCost: 20.5 },
  ]);
  assert.equal(
    preview.upload.expiresAt,
    "2026-08-08T19:30:00.000Z",
  );
  const serialized = JSON.stringify(preview.upload);
  assert.doesNotMatch(serialized, /账户名称|原始行|instrumentMetadata|accountName|rawDraftWarnings/);

  repository.saveBrokerSnapshot({
    id: "confirmed-snapshot-2",
    snapshotAt: "2026-08-05T07:00:00.000Z",
    accountName: null,
    sourceKind: "text",
    importedAt: "2026-08-05T07:01:00.000Z",
    positions: [{ instrumentId: "SSE:603156", quantity: 1000, averageCost: null }],
    rawDraftWarnings: ["第 3 行未解析，无法识别证券"],
  });
  const blocked = previewLocalPortfolioSnapshot(repository, now);
  assert.equal(blocked.upload, null);
  assert.match(blocked.issues.join("\n"), /超过 36 小时/);
  assert.match(blocked.issues.join("\n"), /缺少有效平均成本/);
  assert.match(blocked.issues.join("\n"), /未解析持仓/);
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
