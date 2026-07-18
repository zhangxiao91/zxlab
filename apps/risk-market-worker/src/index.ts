export interface Env {}

type NullableNumber = number | null;
interface StandardQuote {
  instrumentId: string; price: NullableNumber; previousClose: NullableNumber; open: NullableNumber; high: NullableNumber; low: NullableNumber;
  volume: NullableNumber; turnover: NullableNumber; marketTimestamp: string | null; receivedAt: string; source: string; quality: "live" | "cached" | "stale";
  stale: boolean; warnings: string[];
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "Content-Type", "content-type": "application/json; charset=utf-8" };

export function instrumentToTencent(id: string): string {
  const match = /^(SSE|SZSE):(\d{6})$/.exec(id);
  if (!match) throw new GatewayError("INVALID_INSTRUMENT", `不支持的证券代码 ${id}`, 400);
  return `${match[1] === "SSE" ? "sh" : "sz"}${match[2]}`;
}

function finite(value: unknown): number | null { if (value === "" || value == null) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function chinaIso(date: string, time: string): string | null { if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null; return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+08:00`; }

export function parseTencentQuote(instrumentId: string, body: string, receivedAt = new Date().toISOString()): StandardQuote {
  const quoted = body.match(/="([^"]*)"/s)?.[1];
  if (!quoted) throw new GatewayError("EMPTY_RESPONSE", `上游未返回 ${instrumentId} 报价`, 502);
  const fields = quoted.split("~");
  if (fields.length < 35) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `报价字段数量异常：${fields.length}`, 502);
  const marketTimestamp = chinaIso(fields[30]?.slice(0, 8) ?? "", fields[30]?.slice(8, 14) ?? "");
  const age = marketTimestamp ? Math.max(0, (Date.parse(receivedAt) - Date.parse(marketTimestamp)) / 1000) : Number.POSITIVE_INFINITY;
  const price = finite(fields[3]);
  const warnings = [price == null ? "上游缺少现价" : null, marketTimestamp == null ? "上游缺少市场时间" : null, age > 120 ? `报价已过期 ${Math.round(age)} 秒` : null].filter((item): item is string => Boolean(item));
  return { instrumentId, price, previousClose: finite(fields[4]), open: finite(fields[5]), high: finite(fields[33]), low: finite(fields[34]), volume: finite(fields[6]), turnover: finite(fields[37]), marketTimestamp, receivedAt, source: "tencent-qt", quality: age > 120 ? "stale" : "live", stale: age > 120, warnings };
}

export function parseTencentDailyBars(instrumentId: string, code: string, payload: unknown) {
  const root = payload as { data?: Record<string, { day?: unknown[][]; qfqday?: unknown[][] }> };
  const rows = root.data?.[code]?.qfqday ?? root.data?.[code]?.day;
  if (!Array.isArray(rows)) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "日 K 数据结构发生变化", 502);
  return rows.map((row) => ({ instrumentId, timestamp: String(row[0]), open: finite(row[1]), close: finite(row[2]), high: finite(row[3]), low: finite(row[4]), volume: finite(row[5]), turnover: finite(row[6]) }));
}

export function parseTencentMinuteBars(instrumentId: string, code: string, payload: unknown) {
  const root = payload as { data?: Record<string, { data?: { date?: string; data?: string[] } }> };
  const block = root.data?.[code]?.data;
  if (!block || !Array.isArray(block.data)) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "分钟 K 数据结构发生变化", 502);
  const date = block.date ?? "";
  return block.data.map((line) => { const [time, close, volume, turnover] = line.trim().split(/\s+/); return { instrumentId, timestamp: `${date} ${time}`, open: null, high: null, low: null, close: finite(close), volume: finite(volume), turnover: finite(turnover) }; });
}

class GatewayError extends Error { constructor(readonly code: string, message: string, readonly status = 500) { super(message); } }
async function upstream(url: string): Promise<Response> {
  try { const response = await fetch(url, { headers: { "user-agent": "zxlab-risk-market/1.1" }, signal: AbortSignal.timeout(4500) }); if (!response.ok) throw new GatewayError("UPSTREAM_HTTP_ERROR", `上游返回 HTTP ${response.status}`, 502); return response; }
  catch (error) { if (error instanceof GatewayError) throw error; if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new GatewayError("UPSTREAM_TIMEOUT", "行情上游请求超时", 504); throw new GatewayError("UPSTREAM_UNREACHABLE", error instanceof Error ? error.message : "行情上游不可达", 502); }
}
function json(data: unknown, status = 200, cache = "no-store") { return new Response(JSON.stringify(data), { status, headers: { ...CORS, "cache-control": cache } }); }

async function cached(request: Request, seconds: number, ctx: ExecutionContext, loader: () => Promise<unknown>) {
  const cache = await caches.open("risk-market-v1"); const hit = await cache.match(request);
  if (hit) {
    const body = await hit.json() as { data: unknown };
    const data = Array.isArray(body.data) ? body.data.map((item) => item && typeof item === "object" && "quality" in item ? { ...item, quality: "stale" in item && item.stale ? "stale" : "cached" } : item) : body.data;
    return json({ data, meta: { cached: true } }, 200, `public, max-age=${seconds}`);
  }
  const response = json({ data: await loader(), meta: { cached: false } }, 200, `public, max-age=${seconds}`);
  ctx.waitUntil(cache.put(request, response.clone())); return response;
}

async function route(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url); const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/api/market/quotes") {
    const ids = (url.searchParams.get("instruments") ?? "").split(",").filter(Boolean);
    if (!ids.length || ids.length > 30) throw new GatewayError("INVALID_ARGUMENT", "instruments 需要包含 1 至 30 个证券代码", 400);
    return cached(request, 5, ctx, async () => Promise.all(ids.map(async (id) => { const code = instrumentToTencent(id); const response = await upstream(`https://qt.gtimg.cn/q=${code}`); return parseTencentQuote(id, await response.text()); })));
  }
  if (segments.slice(0, 3).join("/") === "api/market/bars" && segments[3]) {
    const id = decodeURIComponent(segments[3]); const code = instrumentToTencent(id); const interval = url.searchParams.get("interval");
    if (interval === "1d") return cached(request, 60, ctx, async () => parseTencentDailyBars(id, code, await (await upstream(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,180,qfq`)).json()));
    if (interval === "1m") return cached(request, 10, ctx, async () => parseTencentMinuteBars(id, code, await (await upstream(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`)).json()));
    throw new GatewayError("INVALID_INTERVAL", "interval 仅支持 1d 或 1m", 400);
  }
  if (url.pathname === "/api/market/status") {
    const exchange = url.searchParams.get("exchange"); if (exchange !== "SSE" && exchange !== "SZSE") throw new GatewayError("INVALID_EXCHANGE", "exchange 仅支持 SSE 或 SZSE", 400);
    const china = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })); const weekday = china.getDay(); const minutes = china.getHours() * 60 + china.getMinutes(); const open = weekday >= 1 && weekday <= 5 && ((minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900));
    return json({ data: { exchange, open, marketTimestamp: new Date().toISOString(), source: "gateway-calendar", warnings: ["未接入节假日交易日历"] } }, 200, "public, max-age=30");
  }
  throw new GatewayError("NOT_FOUND", "未找到行情接口", 404);
}

export default { async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> { if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS }); if (request.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 GET" } }, 405); try { return await route(request, ctx); } catch (error) { const known = error instanceof GatewayError ? error : new GatewayError("INTERNAL_ERROR", "行情网关内部错误", 500); console.error(JSON.stringify({ code: known.code, message: known.message, path: new URL(request.url).pathname })); return json({ error: { code: known.code, message: known.message } }, known.status); } } } satisfies ExportedHandler<Env>;
