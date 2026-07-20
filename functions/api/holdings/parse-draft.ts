import { normalizeHoldingParseDraft, parseLocalHoldingText, type HoldingSourceKind } from "../../../src/features/risk/holdings-parser.ts";
import type { HoldingParseDraft } from "../../../src/features/risk/types.ts";
import { RiskReviewError, type RiskReviewEnv, verifyCloudflareAccess } from "../../_lib/risk/review.ts";

interface FunctionContext { request: Request; env: RiskReviewEnv }
interface ParseDependencies { verifyAccess?: typeof verifyCloudflareAccess; fetcher?: typeof fetch }

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const MAX_INPUT_BYTES = 96 * 1024;
const MAX_GATEWAY_RESPONSE_BYTES = 512 * 1024;

export async function handleHoldingsParseDraft(context: FunctionContext, dependencies: ParseDependencies = {}): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (context.request.method !== "POST") return new Response(JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed." }, requestId }), { status: 405, headers: { ...headers, Allow: "POST" } });
  try {
    await (dependencies.verifyAccess ?? verifyCloudflareAccess)(context.request, context.env);
    const input = await parseRequest(context.request);
    try {
      const draft = await generateGatewayHoldingsDraft(context.request, context.env, input, dependencies.fetcher);
      console.log(JSON.stringify({ event: "risk.holdings_parse.completed", requestId, positions: draft.positions.length, unresolvedRows: draft.unresolvedRows.length, provider: draft.provider, model: draft.model }));
      return json({ ok: true, data: draft, requestId });
    } catch (cause) {
      const fallback = parseLocalHoldingText(input.text, input.sourceKind);
      fallback.warnings.unshift(`LLM 持仓解析暂不可用，已降级本地表格解析：${cause instanceof RiskReviewError ? cause.code : cause instanceof Error ? cause.name : "UNKNOWN"}`);
      console.error(JSON.stringify({ event: "risk.holdings_parse.fallback", requestId, code: cause instanceof RiskReviewError ? cause.code : cause instanceof Error ? cause.name : "UNKNOWN", positions: fallback.positions.length }));
      return json({ ok: true, data: fallback, requestId });
    }
  } catch (cause) {
    const error = cause instanceof RiskReviewError ? cause : new RiskReviewError("UNKNOWN", "持仓解析请求失败。", 500, { cause });
    console.error(JSON.stringify({ event: "risk.holdings_parse.rejected", requestId, code: error.code, status: error.status }));
    return json({ ok: false, error: { code: error.code, message: error.safeMessage }, requestId }, error.status);
  }
}

async function parseRequest(request: Request): Promise<{ text: string; sourceKind: HoldingSourceKind }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RiskReviewError("INVALID_INPUT", "Content-Type 必须为 application/json。", 400);
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INPUT_BYTES) throw new RiskReviewError("INPUT_TOO_LARGE", "持仓文本超过请求上限。", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_INPUT_BYTES) throw new RiskReviewError("INPUT_TOO_LARGE", "持仓文本超过请求上限。", 413);
  let body: unknown;
  try { body = JSON.parse(raw) as unknown; }
  catch (cause) { throw new RiskReviewError("INVALID_INPUT", "请求不是有效 JSON。", 400, { cause }); }
  const root = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (!root || typeof root.text !== "string" || !root.text.trim()) throw new RiskReviewError("INVALID_INPUT", "需要提供持仓文本。", 400);
  if (root.text.length > 60_000) throw new RiskReviewError("INPUT_TOO_LARGE", "持仓文本超过解析上限。", 413);
  const sourceKind = root.sourceKind === "csv" ? "csv" : "text";
  return { text: root.text.trim(), sourceKind };
}

async function generateGatewayHoldingsDraft(request: Request, env: RiskReviewEnv, input: { text: string; sourceKind: HoldingSourceKind }, fetcher: typeof fetch = fetch): Promise<HoldingParseDraft> {
  const token = env.AI_GATEWAY_ACCESS_TOKEN?.trim();
  if (!token) throw new RiskReviewError("MISSING_GATEWAY_TOKEN", "项目 LLM 网关凭据缺失。", 503);
  const body = {
    task: "holdings-parse",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ sourceKind: input.sourceKind, text: input.text }) },
    ],
    temperature: 0,
    maxOutputTokens: 2_400,
    responseFormat: { type: "json" },
  };
  let gateway: GatewaySuccess;
  try {
    gateway = await requestGatewayStream(request, token, body, fetcher);
  } catch (cause) {
    if (!(cause instanceof GatewayStreamUnavailableError || cause instanceof TypeError)) throw cause;
    gateway = await requestGatewayJson(request, token, body, fetcher);
  }
  return normalizeHoldingParseDraft(gateway.data.json, { sourceKind: input.sourceKind, provider: gateway.data.provider, model: gateway.data.model, requestId: gateway.requestId });
}

const SYSTEM_PROMPT = `你是券商持仓文本解析器，只能把用户提供的持仓文本或 CSV 转成 JSON 草稿，不能给交易建议，不能推断买卖计划，不能修改账本。证券代码必须规范为 SSE:xxxxxx 或 SZSE:xxxxxx；无法确认交易所时 instrumentId 为 null 并写 warnings。数量、可用数量、平均成本、市值、浮动盈亏必须是 number 或 null。confidence 范围 0 到 1。输出且仅输出 JSON：{"snapshotAt":"ISO string","accountName":"string|null","sourceKind":"csv|text","positions":[{"rawName":"string|null","rawSymbol":"string|null","instrumentId":"SSE:000000|SZSE:000000|null","quantity":number|null,"availableQuantity":number|null,"averageCost":number|null,"marketValue":number|null,"unrealizedPnl":number|null,"currency":"CNY|null","confidence":number,"warnings":["string"]}],"unresolvedRows":[{"rowNumber":number|null,"raw":"string","reason":"string"}],"warnings":["string"]}。`;

type GatewayData = { json: unknown; provider: string; model: string; fallbackIndex: number; latencyMs?: number; usage?: unknown; attempts?: number };
type GatewaySuccess = { data: GatewayData; requestId: string };

class GatewayStreamUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "GatewayStreamUnavailableError"; }
}

async function requestGatewayJson(request: Request, token: string, body: unknown, fetcher: typeof fetch): Promise<GatewaySuccess> {
  const response = await fetcher.call(globalThis, new URL("/api/ai/generate", request.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return parseGatewaySuccess(await readJson(response), response.status);
}

async function requestGatewayStream(request: Request, token: string, body: unknown, fetcher: typeof fetch): Promise<GatewaySuccess> {
  const response = await fetcher.call(globalThis, new URL("/api/ai/stream", request.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 501) throw new GatewayStreamUnavailableError(`stream returned ${response.status}`);
    return parseGatewaySuccess(await readJson(response), response.status);
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) throw new GatewayStreamUnavailableError("stream unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let bytes = 0;
  const parseData = (): GatewaySuccess | undefined => {
    if (!dataLines.length) return undefined;
    const raw = dataLines.join("\n");
    dataLines = [];
    const event = JSON.parse(raw) as { type?: string; requestId?: string; data?: GatewayData; error?: { code?: string } };
    if (!event.type || !event.requestId) throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关流事件无效。", 502);
    if (event.type === "done") return parseGatewaySuccess({ ok: true, data: event.data, requestId: event.requestId }, response.status);
    if (event.type === "error") throw new RiskReviewError(`GATEWAY_${event.error?.code ?? "UNKNOWN"}`, "项目 LLM 网关暂不可用。", 502);
    return undefined;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_GATEWAY_RESPONSE_BYTES) throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关响应过大。", 502);
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          const result = parseData();
          if (result) return result;
        } else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
    const result = parseData();
    if (result) return result;
  } finally {
    reader.releaseLock();
  }
  throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关流在完成前结束。", 502);
}

async function readJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GATEWAY_RESPONSE_BYTES) throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关响应过大。", 502);
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_GATEWAY_RESPONSE_BYTES) throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关响应过大。", 502);
  try { return JSON.parse(raw) as unknown; }
  catch (cause) { throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关返回了无效 JSON。", 502, { cause }); }
}

function parseGatewaySuccess(payload: unknown, status: number): GatewaySuccess {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const data = root?.data && typeof root.data === "object" ? root.data as Partial<GatewayData> : null;
  const error = root?.error && typeof root.error === "object" ? root.error as Record<string, unknown> : null;
  if (!root || root.ok !== true || !data || typeof root.requestId !== "string") {
    const code = typeof error?.code === "string" ? error.code : `HTTP_${status}`;
    throw new RiskReviewError(`GATEWAY_${code}`, "项目 LLM 网关暂不可用。", 502);
  }
  if (typeof data.provider !== "string" || typeof data.model !== "string" || typeof data.fallbackIndex !== "number" || data.json === undefined) {
    throw new RiskReviewError("INVALID_GATEWAY_RESPONSE", "项目 LLM 网关响应结构无效。", 502);
  }
  return { data: data as GatewayData, requestId: root.requestId };
}

export const onRequest = (context: FunctionContext) => handleHoldingsParseDraft(context);
