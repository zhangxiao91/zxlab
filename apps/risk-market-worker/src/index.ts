type NullableNumber = number | null;
type Quality = "live" | "cached" | "stale" | "unavailable";
type Capability = "quote" | "daily-bars" | "minute-bars" | "stock-news" | "market-news" | "announcement";
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
  message: string | null;
}

export interface StandardQuote {
  instrumentId: string;
  price: NullableNumber;
  previousClose: NullableNumber;
  open: NullableNumber;
  high: NullableNumber;
  low: NullableNumber;
  volume: NullableNumber;
  turnover: NullableNumber;
  marketTimestamp: string | null;
  receivedAt: string;
  source: string;
  quality: Quality;
  stale: boolean;
  warnings: string[];
  fallbackUsed: boolean;
  providerAttempts: ProviderAttempt[];
}

export interface StandardBar {
  instrumentId: string;
  timestamp: string;
  open: NullableNumber;
  high: NullableNumber;
  low: NullableNumber;
  close: NullableNumber;
  volume: NullableNumber;
  turnover: NullableNumber;
  source: string;
}

export interface StandardNewsItem {
  id: string;
  type: "stock-news" | "market-news" | "announcement";
  title: string;
  url: string;
  summary: string | null;
  content: string | null;
  source: string;
  publishedAt: string | null;
  receivedAt: string;
  instrumentId: string | null;
  symbol: string | null;
  warnings: string[];
}

interface Provider<T> {
  name: string;
  load(fetcher: Fetcher): Promise<T>;
}

interface FallbackResult<T> {
  data: T;
  source: string;
  fallbackUsed: boolean;
  attempts: ProviderAttempt[];
}

interface LoadResult<T> {
  data: T;
  meta: Record<string, unknown>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "content-type": "application/json; charset=utf-8",
};
const MAX_UPSTREAM_BYTES = 2_000_000;
const UPSTREAM_TIMEOUT_MS = 4_500;

export function instrumentToCode(id: string): { exchange: "SSE" | "SZSE"; symbol: string; prefixed: string; secid: string } {
  const match = /^(SSE|SZSE):(\d{6})$/.exec(id);
  if (!match) throw new GatewayError("INVALID_INSTRUMENT", `不支持的证券代码 ${id}`, 400);
  const exchange = match[1] as "SSE" | "SZSE";
  return { exchange, symbol: match[2], prefixed: `${exchange === "SSE" ? "sh" : "sz"}${match[2]}`, secid: `${exchange === "SSE" ? "1" : "0"}.${match[2]}` };
}

export function instrumentToTencent(id: string): string { return instrumentToCode(id).prefixed; }

function finite(value: unknown): number | null {
  if (value === "" || value == null || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function multiplied(value: unknown, factor: number): number | null {
  const parsed = finite(value);
  return parsed == null ? null : parsed * factor;
}

function chinaIso(date: string, time: string): string | null {
  const normalizedDate = date.replaceAll("-", "");
  const normalizedTime = time.replaceAll(":", "");
  if (!/^\d{8}$/.test(normalizedDate) || !/^\d{6}$/.test(normalizedTime)) return null;
  return `${normalizedDate.slice(0, 4)}-${normalizedDate.slice(4, 6)}-${normalizedDate.slice(6, 8)}T${normalizedTime.slice(0, 2)}:${normalizedTime.slice(2, 4)}:${normalizedTime.slice(4, 6)}+08:00`;
}

function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1_000;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  const text = String(value).trim();
  if (!text) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const normalized = /^\d{8}$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00+08:00`
    : `${text.includes("T") ? text : text.replace(" ", "T")}${hasZone ? "" : "+08:00"}`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function compactText(value: unknown, max = 2_000): string | null {
  if (value == null) return null;
  const text = String(value).replace(/<\s*br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function parseJsonOrJsonp(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "JSONP 结构发生变化", 502);
  return JSON.parse(trimmed.slice(start, end + 1));
}

function quoteFreshness(marketTimestamp: string | null, receivedAt: string) {
  const ageSeconds = marketTimestamp ? Math.max(0, (Date.parse(receivedAt) - Date.parse(marketTimestamp)) / 1000) : Number.POSITIVE_INFINITY;
  return { stale: ageSeconds > 120, ageSeconds };
}

function quoteWarnings(price: number | null, marketTimestamp: string | null, ageSeconds: number): string[] {
  return [
    price == null ? "上游缺少现价" : null,
    marketTimestamp == null ? "上游缺少市场时间" : null,
    ageSeconds > 120 && Number.isFinite(ageSeconds) ? `报价已过期 ${Math.round(ageSeconds)} 秒` : null,
  ].filter((item): item is string => Boolean(item));
}

export function parseTencentQuote(instrumentId: string, body: string, receivedAt = new Date().toISOString()): StandardQuote {
  const quoted = body.match(/="([^"]*)"/s)?.[1];
  if (!quoted) throw new GatewayError("EMPTY_RESPONSE", `腾讯未返回 ${instrumentId} 报价`, 502);
  const fields = quoted.split("~");
  if (fields.length < 35) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `腾讯报价字段数量异常：${fields.length}`, 502);
  const marketTimestamp = chinaIso(fields[30]?.slice(0, 8) ?? "", fields[30]?.slice(8, 14) ?? "");
  const price = finite(fields[3]);
  if (price == null) throw new GatewayError("EMPTY_PRICE", `腾讯 ${instrumentId} 现价为空`, 502);
  const freshness = quoteFreshness(marketTimestamp, receivedAt);
  return { instrumentId, price, previousClose: finite(fields[4]), open: finite(fields[5]), high: finite(fields[33]), low: finite(fields[34]), volume: multiplied(fields[6], 100), turnover: multiplied(fields[37], 10_000), marketTimestamp, receivedAt, source: "tencent-qt", quality: freshness.stale ? "stale" : "live", stale: freshness.stale, warnings: quoteWarnings(price, marketTimestamp, freshness.ageSeconds), fallbackUsed: false, providerAttempts: [] };
}

export function parseSinaQuote(instrumentId: string, body: string, receivedAt = new Date().toISOString()): StandardQuote {
  const quoted = body.match(/="([^"]*)"/s)?.[1];
  if (!quoted) throw new GatewayError("EMPTY_RESPONSE", `新浪未返回 ${instrumentId} 报价`, 502);
  const fields = quoted.split(",");
  if (fields.length < 32) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `新浪报价字段数量异常：${fields.length}`, 502);
  const marketTimestamp = chinaIso(fields[30] ?? "", fields[31] ?? "");
  const price = finite(fields[3]);
  if (price == null) throw new GatewayError("EMPTY_PRICE", `新浪 ${instrumentId} 现价为空`, 502);
  const freshness = quoteFreshness(marketTimestamp, receivedAt);
  return { instrumentId, price, previousClose: finite(fields[2]), open: finite(fields[1]), high: finite(fields[4]), low: finite(fields[5]), volume: finite(fields[8]), turnover: finite(fields[9]), marketTimestamp, receivedAt, source: "sina-hq", quality: freshness.stale ? "stale" : "live", stale: freshness.stale, warnings: quoteWarnings(price, marketTimestamp, freshness.ageSeconds), fallbackUsed: true, providerAttempts: [] };
}

export function parseEastmoneyQuote(instrumentId: string, payload: unknown, receivedAt = new Date().toISOString()): StandardQuote {
  const root = payload as { data?: Record<string, unknown> | null };
  const data = root.data;
  if (!data) throw new GatewayError("EMPTY_RESPONSE", `东财未返回 ${instrumentId} 报价`, 502);
  const precision = finite(data.f59) ?? 2;
  const scaled = (raw: unknown) => { const parsed = finite(raw); return parsed == null ? null : parsed / 10 ** precision; };
  const rawTimestamp = finite(data.f86);
  const marketTimestamp = rawTimestamp == null ? null : new Date(rawTimestamp * 1000).toISOString();
  const price = scaled(data.f43);
  if (price == null) throw new GatewayError("EMPTY_PRICE", `东财 ${instrumentId} 现价为空`, 502);
  const freshness = quoteFreshness(marketTimestamp, receivedAt);
  return { instrumentId, price, previousClose: scaled(data.f60), open: scaled(data.f46), high: scaled(data.f44), low: scaled(data.f45), volume: multiplied(data.f47, 100), turnover: finite(data.f48), marketTimestamp, receivedAt, source: "eastmoney-push2", quality: freshness.stale ? "stale" : "live", stale: freshness.stale, warnings: quoteWarnings(price, marketTimestamp, freshness.ageSeconds), fallbackUsed: true, providerAttempts: [] };
}

export function parseTencentDailyBars(instrumentId: string, code: string, payload: unknown): StandardBar[] {
  const root = payload as { data?: Record<string, { day?: unknown[][]; qfqday?: unknown[][] }> };
  const rows = root.data?.[code]?.qfqday ?? root.data?.[code]?.day;
  if (!Array.isArray(rows) || !rows.length) throw new GatewayError("EMPTY_RESPONSE", "腾讯日 K 返回空", 502);
  return rows.map((row) => ({ instrumentId, timestamp: String(row[0]), open: finite(row[1]), close: finite(row[2]), high: finite(row[3]), low: finite(row[4]), volume: multiplied(row[5], 100), turnover: finite(row[6]), source: "tencent-kline" }));
}

export function parseBaiduDailyBars(instrumentId: string, payload: unknown): StandardBar[] {
  const root = payload as { Result?: { newMarketData?: { keys?: string[]; marketData?: string } } };
  const keys = root.Result?.newMarketData?.keys;
  const rows = root.Result?.newMarketData?.marketData;
  if (!Array.isArray(keys) || !rows) throw new GatewayError("EMPTY_RESPONSE", "百度日 K 返回空", 502);
  const index = (name: string) => keys.indexOf(name);
  const valueAt = (fields: string[], name: string) => index(name) >= 0 ? fields[index(name)] : null;
  const bars = rows.split(";").filter(Boolean).map((line) => {
    const fields = line.split(",");
    return { instrumentId, timestamp: String(valueAt(fields, "time") ?? ""), open: finite(valueAt(fields, "open")), close: finite(valueAt(fields, "close")), high: finite(valueAt(fields, "high")), low: finite(valueAt(fields, "low")), volume: finite(valueAt(fields, "volume")), turnover: finite(valueAt(fields, "amount")), source: "baidu-gushitong" };
  });
  if (!bars.length || bars.every((bar) => bar.close == null)) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "百度日 K 字段发生变化", 502);
  return bars;
}

export function parseSinaBars(instrumentId: string, payload: unknown, source: string): StandardBar[] {
  if (!Array.isArray(payload) || !payload.length) throw new GatewayError("EMPTY_RESPONSE", "新浪 K 线返回空", 502);
  const bars = payload.map((item) => {
    const row = item as Record<string, unknown>;
    return { instrumentId, timestamp: String(row.day ?? row.date ?? ""), open: finite(row.open), close: finite(row.close), high: finite(row.high), low: finite(row.low), volume: finite(row.volume), turnover: finite(row.amount), source };
  });
  if (bars.every((bar) => bar.close == null)) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "新浪 K 线字段发生变化", 502);
  return bars;
}

export function parseTonghuashunDailyBars(instrumentId: string, body: string): StandardBar[] {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "同花顺日 K JSONP 结构发生变化", 502);
  let payload: { data?: string };
  try { payload = JSON.parse(body.slice(start, end + 1)) as { data?: string }; }
  catch { throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "同花顺日 K JSONP 无法解析", 502); }
  if (!payload.data) throw new GatewayError("EMPTY_RESPONSE", "同花顺日 K 返回空", 502);
  const bars = payload.data.split(";").filter(Boolean).map((line) => {
    const [timestamp, open, high, low, close, volume, turnover] = line.split(",");
    return { instrumentId, timestamp, open: finite(open), high: finite(high), low: finite(low), close: finite(close), volume: finite(volume), turnover: finite(turnover), source: "tonghuashun-kline" };
  });
  if (!bars.length || bars.every((bar) => bar.close == null)) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "同花顺日 K 字段发生变化", 502);
  return bars;
}

export function parseTencentMinuteBars(instrumentId: string, code: string, payload: unknown): StandardBar[] {
  const root = payload as { data?: Record<string, { data?: { date?: string; data?: string[] } }> };
  const block = root.data?.[code]?.data;
  if (!block || !Array.isArray(block.data) || !block.data.length) throw new GatewayError("EMPTY_RESPONSE", "腾讯分钟 K 返回空", 502);
  const date = block.date ?? "";
  return block.data.map((line) => { const [time, close, volume, turnover] = line.trim().split(/\s+/); return { instrumentId, timestamp: `${date} ${time}`, open: null, high: null, low: null, close: finite(close), volume: multiplied(volume, 100), turnover: finite(turnover), source: "tencent-minute" }; });
}

export function parseEastmoneyMinuteBars(instrumentId: string, payload: unknown): StandardBar[] {
  const root = payload as { data?: { trends?: string[] } | null };
  const rows = root.data?.trends;
  if (!Array.isArray(rows) || !rows.length) throw new GatewayError("EMPTY_RESPONSE", "东财分钟 K 返回空", 502);
  return rows.map((line) => { const [timestamp, open, close, high, low, volume, turnover] = line.split(","); return { instrumentId, timestamp, open: finite(open), close: finite(close), high: finite(high), low: finite(low), volume: multiplied(volume, 100), turnover: finite(turnover), source: "eastmoney-trends" }; });
}

function newsItem(input: {
  id: string; type: StandardNewsItem["type"]; title: string; url: string; summary?: unknown; content?: unknown;
  source: string; publishedAt?: unknown; instrumentId?: string | null; symbol?: string | null; warnings?: string[];
}): StandardNewsItem {
  return {
    id: input.id,
    type: input.type,
    title: compactText(input.title, 240) ?? input.title,
    url: input.url,
    summary: compactText(input.summary),
    content: compactText(input.content, 8_000),
    source: input.source,
    publishedAt: toIso(input.publishedAt),
    receivedAt: new Date().toISOString(),
    instrumentId: input.instrumentId ?? null,
    symbol: input.symbol ?? null,
    warnings: input.warnings ?? ["external_text_is_untrusted"],
  };
}

function eastmoneyRows(payload: unknown): Record<string, unknown>[] {
  const root = payload as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | undefined;
  const candidates = [
    data?.list,
    data?.news,
    data?.fastNewsList,
    data?.cmsArticleWebOld,
    root.list,
    root.news,
    root.fastNewsList,
  ];
  const rows = candidates.find(Array.isArray);
  if (!Array.isArray(rows)) throw new GatewayError("EMPTY_RESPONSE", "东财消息返回空", 502);
  return rows as Record<string, unknown>[];
}

export function parseEastmoneyStockNews(instrumentId: string, payload: unknown): StandardNewsItem[] {
  const { symbol } = instrumentToCode(instrumentId);
  const rows = eastmoneyRows(payload);
  const items = rows.flatMap((row): StandardNewsItem[] => {
    const id = compactText(row.code ?? row.infoCode ?? row.artCode ?? row.id, 120);
    const title = compactText(row.title ?? row.name, 240);
    const url = compactText(row.url ?? row.artUrl ?? row.link, 2_048);
    if (!id || !title || !url) return [];
    return [newsItem({ id: `eastmoney-stock:${id}`, type: "stock-news", title, url, summary: row.digest ?? row.summary, content: row.content, source: "eastmoney-stock-news", publishedAt: row.showTime ?? row.publishTime ?? row.date, instrumentId, symbol })];
  });
  if (!items.length) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "东财个股新闻字段发生变化", 502);
  return items;
}

export function parseEastmoneyFastNews(payload: unknown): StandardNewsItem[] {
  const rows = eastmoneyRows(payload);
  const items = rows.flatMap((row): StandardNewsItem[] => {
    const id = compactText(row.code ?? row.infoCode ?? row.id, 120);
    const title = compactText(row.title ?? row.digest, 240);
    const url = compactText(row.url ?? row.link, 2_048) ?? (id ? `https://finance.eastmoney.com/a/${encodeURIComponent(id)}.html` : null);
    if (!id || !title || !url) return [];
    return [newsItem({ id: `eastmoney-724:${id}`, type: "market-news", title, url, summary: row.digest ?? row.summary, content: row.content, source: "eastmoney-724", publishedAt: row.showTime ?? row.publishTime ?? row.date })];
  });
  if (!items.length) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "东财 7x24 字段发生变化", 502);
  return items;
}

export function parseCninfoAnnouncements(instrumentId: string, payload: unknown): StandardNewsItem[] {
  const { symbol } = instrumentToCode(instrumentId);
  const rows = (payload as { announcements?: unknown[]; data?: { announcements?: unknown[] } }).announcements
    ?? (payload as { data?: { announcements?: unknown[] } }).data?.announcements;
  if (!Array.isArray(rows)) throw new GatewayError("EMPTY_RESPONSE", "巨潮公告返回空", 502);
  const items = rows.flatMap((raw): StandardNewsItem[] => {
    const row = raw as Record<string, unknown>;
    const id = compactText(row.announcementId ?? row.id, 120);
    const title = compactText(row.announcementTitle ?? row.title, 240);
    const adjunct = compactText(row.adjunctUrl ?? row.url, 2_048);
    if (!id || !title || !adjunct) return [];
    const url = adjunct.startsWith("http") ? adjunct : `https://static.cninfo.com.cn/${adjunct.replace(/^\/+/, "")}`;
    return [newsItem({ id: `cninfo:${id}`, type: "announcement", title, url, summary: row.announcementContent, source: "cninfo-announcement", publishedAt: row.announcementTime ?? row.publishTime, instrumentId, symbol })];
  });
  if (!items.length) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "巨潮公告字段发生变化", 502);
  return items;
}

class GatewayError extends Error {
  constructor(readonly code: string, message: string, readonly status = 500) { super(message); }
}

async function upstream(fetcher: Fetcher, url: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    const response = await fetcher(url, { headers: { "user-agent": "zxlab-risk-market/1.2", ...headers }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!response.ok) throw new GatewayError("UPSTREAM_HTTP_ERROR", `上游返回 HTTP ${response.status}`, 502);
    const contentLength = finite(response.headers.get("content-length"));
    if (contentLength != null && contentLength > MAX_UPSTREAM_BYTES) throw new GatewayError("UPSTREAM_TOO_LARGE", "上游响应超过安全上限", 502);
    return response;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new GatewayError("UPSTREAM_TIMEOUT", "行情上游请求超时", 504);
    throw new GatewayError("UPSTREAM_UNREACHABLE", error instanceof Error ? error.message : "行情上游不可达", 502);
  }
}

async function upstreamJsonp(fetcher: Fetcher, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return parseJsonOrJsonp(await (await upstream(fetcher, url, headers)).text());
}

export async function runWithFallback<T>(capability: Capability, providers: Provider<T>[], fetcher: Fetcher = fetch): Promise<FallbackResult<T>> {
  const attempts: ProviderAttempt[] = [];
  for (const provider of providers) {
    const startedAt = performance.now();
    try {
      const data = await provider.load(fetcher);
      attempts.push({ provider: provider.name, ok: true, latencyMs: Math.round(performance.now() - startedAt), errorCode: null, message: null });
      console.log(JSON.stringify({ event: "market_provider_success", capability, provider: provider.name, fallbackUsed: attempts.length > 1, attempts: attempts.length }));
      return { data, source: provider.name, fallbackUsed: attempts.length > 1, attempts };
    } catch (error) {
      const known = error instanceof GatewayError ? error : new GatewayError("PROVIDER_ERROR", error instanceof Error ? error.message : "Provider 失败", 502);
      attempts.push({ provider: provider.name, ok: false, latencyMs: Math.round(performance.now() - startedAt), errorCode: known.code, message: known.message });
      console.warn(JSON.stringify({ event: "market_provider_failed", capability, provider: provider.name, code: known.code, message: known.message }));
    }
  }
  throw new AllProvidersFailedError(capability, attempts);
}

class AllProvidersFailedError extends GatewayError {
  constructor(readonly capability: Capability, readonly attempts: ProviderAttempt[]) { super("ALL_PROVIDERS_FAILED", `${capability} 的 ${attempts.length} 个 Provider 均失败`, 502); }
}

function quoteProviders(instrumentId: string): Provider<StandardQuote>[] {
  const code = instrumentToCode(instrumentId);
  return [
    { name: "tencent-qt", load: async (fetcher) => parseTencentQuote(instrumentId, await (await upstream(fetcher, `https://qt.gtimg.cn/q=${code.prefixed}`)).text()) },
    { name: "sina-hq", load: async (fetcher) => parseSinaQuote(instrumentId, await (await upstream(fetcher, `https://hq.sinajs.cn/list=${code.prefixed}`, { referer: "https://finance.sina.com.cn/" })).text()) },
    { name: "eastmoney-push2", load: async (fetcher) => parseEastmoneyQuote(instrumentId, await (await upstream(fetcher, `https://push2.eastmoney.com/api/qt/stock/get?secid=${code.secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f86`)).json()) },
  ];
}

function dailyProviders(instrumentId: string): Provider<StandardBar[]>[] {
  const code = instrumentToCode(instrumentId);
  const baiduUrl = `https://finance.pae.baidu.com/selfselect/getstockquotation?all=1&isIndex=false&isBk=false&isBlock=false&isFutures=false&isStock=true&newFormat=1&group=quotation_kline_ab&finClientType=pc&code=${code.symbol}&ktype=1`;
  return [
    { name: "tencent-kline", load: async (fetcher) => parseTencentDailyBars(instrumentId, code.prefixed, await (await upstream(fetcher, `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code.prefixed},day,,,180,qfq`)).json()) },
    { name: "baidu-gushitong", load: async (fetcher) => parseBaiduDailyBars(instrumentId, await (await upstream(fetcher, baiduUrl, { accept: "application/vnd.finance-web.v1+json", origin: "https://gushitong.baidu.com", referer: "https://gushitong.baidu.com/" })).json()) },
    { name: "tonghuashun-kline", load: async (fetcher) => parseTonghuashunDailyBars(instrumentId, await (await upstream(fetcher, `https://d.10jqka.com.cn/v6/line/hs_${code.symbol}/01/last.js`, { referer: "https://stockpage.10jqka.com.cn/" })).text()) },
  ];
}

function minuteProviders(instrumentId: string): Provider<StandardBar[]>[] {
  const code = instrumentToCode(instrumentId);
  return [
    { name: "tencent-minute", load: async (fetcher) => parseTencentMinuteBars(instrumentId, code.prefixed, await (await upstream(fetcher, `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code.prefixed}`)).json()) },
    { name: "sina-minute", load: async (fetcher) => parseSinaBars(instrumentId, await (await upstream(fetcher, `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${code.prefixed}&scale=1&ma=no&datalen=240`)).json(), "sina-minute") },
    { name: "eastmoney-trends", load: async (fetcher) => parseEastmoneyMinuteBars(instrumentId, await (await upstream(fetcher, `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${code.secid}&ndays=1&iscr=0&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58`)).json()) },
  ];
}

function stockNewsProviders(instrumentId: string, limit: number): Provider<StandardNewsItem[]>[] {
  const code = instrumentToCode(instrumentId);
  const param = JSON.stringify({
    uid: "",
    keyword: code.symbol,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "default", pageIndex: 1, pageSize: Math.min(limit, 50) } },
  });
  return [
    {
      name: "eastmoney-stock-news",
      load: async (fetcher) => parseEastmoneyStockNews(instrumentId, await upstreamJsonp(fetcher, `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery1124&param=${encodeURIComponent(param)}`, { referer: "https://so.eastmoney.com/" })),
    },
  ];
}

function fastNewsProviders(limit: number): Provider<StandardNewsItem[]>[] {
  return [
    {
      name: "eastmoney-724",
      load: async (fetcher) => parseEastmoneyFastNews(await (await upstream(fetcher, `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&pageSize=${Math.min(limit, 80)}&pageNo=1`, { referer: "https://finance.eastmoney.com/" })).json()),
    },
  ];
}

function announcementProviders(instrumentId: string, limit: number): Provider<StandardNewsItem[]>[] {
  const code = instrumentToCode(instrumentId);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const start = new Date(Date.now() - 14 * 24 * 3_600_000).toISOString().slice(0, 10);
  const body = new URLSearchParams({
    pageNum: "1",
    pageSize: String(Math.min(limit, 50)),
    column: code.exchange === "SSE" ? "sse" : "szse",
    tabName: "fulltext",
    plate: "",
    stock: code.symbol,
    searchkey: "",
    secid: "",
    category: "",
    trade: "",
    seDate: `${start}~${today}`,
    sortName: "",
    sortType: "",
    isHLtitle: "true",
  });
  return [
    {
      name: "cninfo-announcement",
      load: async (fetcher) => {
        const response = await fetcher("https://www.cninfo.com.cn/new/hisAnnouncement/query", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://www.cninfo.com.cn", referer: "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch" },
          body,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!response.ok) throw new GatewayError("UPSTREAM_HTTP_ERROR", `巨潮返回 HTTP ${response.status}`, 502);
        return parseCninfoAnnouncements(instrumentId, await response.json());
      },
    },
  ];
}

function unavailableQuote(instrumentId: string, error: AllProvidersFailedError): StandardQuote {
  return { instrumentId, price: null, previousClose: null, open: null, high: null, low: null, volume: null, turnover: null, marketTimestamp: null, receivedAt: new Date().toISOString(), source: "unavailable", quality: "unavailable", stale: true, warnings: [error.message, ...error.attempts.map((item) => `${item.provider}: ${item.errorCode}`)], fallbackUsed: true, providerAttempts: error.attempts };
}

function withQuoteDiagnostics(result: FallbackResult<StandardQuote>): StandardQuote {
  const fallbackWarning = result.fallbackUsed ? [`主源失败，已降级至 ${result.source}`] : [];
  return { ...result.data, source: result.source, fallbackUsed: result.fallbackUsed, providerAttempts: result.attempts, warnings: [...fallbackWarning, ...result.data.warnings] };
}

function json(data: unknown, status = 200, cache = "no-store") { return new Response(JSON.stringify(data), { status, headers: { ...CORS, "cache-control": cache } }); }

async function cached<T>(request: Request, seconds: number, ctx: ExecutionContext, loader: () => Promise<LoadResult<T>>) {
  const cache = await caches.open("risk-market-v2");
  const hit = await cache.match(request);
  if (hit) {
    const body = await hit.json() as LoadResult<T>;
    const data = Array.isArray(body.data) ? body.data.map((item) => item && typeof item === "object" && "quality" in item ? { ...item, quality: "stale" in item && item.stale ? "stale" : "cached" } : item) : body.data;
    return json({ data, meta: { ...body.meta, cached: true } }, 200, `public, max-age=${seconds}`);
  }
  const loaded = await loader();
  const response = json({ data: loaded.data, meta: { ...loaded.meta, cached: false } }, 200, `public, max-age=${seconds}`);
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function loadQuotes(ids: string[]): Promise<LoadResult<StandardQuote[]>> {
  const resolved = await mapWithConcurrency(ids, 1, async (id) => {
    try { return withQuoteDiagnostics(await runWithFallback("quote", quoteProviders(id))); }
    catch (error) { if (error instanceof AllProvidersFailedError) return unavailableQuote(id, error); throw error; }
  });
  const sources = [...new Set(resolved.map((item) => item.source))];
  return { data: resolved, meta: { capability: "quote", providerChain: ["tencent-qt", "sina-hq", "eastmoney-push2"], sources, fallbackCount: resolved.filter((item) => item.fallbackUsed).length, unavailableCount: resolved.filter((item) => item.quality === "unavailable").length } };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadBars(instrumentId: string, interval: "1d" | "1m"): Promise<LoadResult<StandardBar[]>> {
  const capability = interval === "1d" ? "daily-bars" : "minute-bars";
  const providers = interval === "1d" ? dailyProviders(instrumentId) : minuteProviders(instrumentId);
  const result = await runWithFallback(capability, providers);
  return { data: result.data, meta: { capability, source: result.source, fallbackUsed: result.fallbackUsed, providerChain: providers.map((item) => item.name), attempts: result.attempts } };
}

function dedupNews(items: StandardNewsItem[], limit: number): StandardNewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => Date.parse(right.publishedAt ?? right.receivedAt) - Date.parse(left.publishedAt ?? left.receivedAt)).slice(0, limit);
}

async function loadAnnouncements(instrumentId: string, limit: number): Promise<LoadResult<StandardNewsItem[]>> {
  const result = await runWithFallback("announcement", announcementProviders(instrumentId, limit));
  return { data: result.data, meta: { capability: "announcement", source: result.source, fallbackUsed: result.fallbackUsed, providerChain: ["cninfo-announcement"], attempts: result.attempts } };
}

async function loadMarketNews(ids: string[], limit: number): Promise<LoadResult<StandardNewsItem[]>> {
  const attempts: ProviderAttempt[] = [];
  const warnings: string[] = [];
  const batches: StandardNewsItem[][] = [];
  try {
    const result = await runWithFallback("market-news", fastNewsProviders(limit));
    attempts.push(...result.attempts);
    batches.push(result.data);
  } catch (error) {
    const known = error instanceof AllProvidersFailedError ? error : null;
    if (known) attempts.push(...known.attempts);
    warnings.push("eastmoney-724 unavailable");
  }
  for (const id of ids) {
    try {
      const stock = await runWithFallback("stock-news", stockNewsProviders(id, Math.max(4, Math.ceil(limit / Math.max(ids.length, 1)))));
      attempts.push(...stock.attempts);
      batches.push(stock.data);
    } catch (error) {
      const known = error instanceof AllProvidersFailedError ? error : null;
      if (known) attempts.push(...known.attempts);
      warnings.push(`${id} stock news unavailable`);
    }
    try {
      const announcements = await runWithFallback("announcement", announcementProviders(id, Math.max(4, Math.ceil(limit / Math.max(ids.length, 1)))));
      attempts.push(...announcements.attempts);
      batches.push(announcements.data);
    } catch (error) {
      const known = error instanceof AllProvidersFailedError ? error : null;
      if (known) attempts.push(...known.attempts);
      warnings.push(`${id} announcements unavailable`);
    }
  }
  return { data: dedupNews(batches.flat(), limit), meta: { capability: "market-news", providerChain: ["eastmoney-724", "eastmoney-stock-news", "cninfo-announcement"], attempts, warnings } };
}

async function route(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/api/market/providers") return json({ data: { quote: ["tencent-qt", "sina-hq", "eastmoney-push2"], dailyBars: ["tencent-kline", "baidu-gushitong", "tonghuashun-kline"], minuteBars: ["tencent-minute", "sina-minute", "eastmoney-trends"], news: ["eastmoney-724", "eastmoney-stock-news", "cninfo-announcement"], strategy: "sequential-fallback", timeoutMsPerProvider: UPSTREAM_TIMEOUT_MS } }, 200, "public, max-age=300");
  if (url.pathname === "/api/market/quotes") {
    const ids = (url.searchParams.get("instruments") ?? "").split(",").filter(Boolean);
    if (!ids.length || ids.length > 30) throw new GatewayError("INVALID_ARGUMENT", "instruments 需要包含 1 至 30 个证券代码", 400);
    ids.forEach(instrumentToCode);
    return cached(request, 5, ctx, () => loadQuotes(ids));
  }
  if (segments.slice(0, 3).join("/") === "api/market/bars" && segments[3]) {
    const id = decodeURIComponent(segments[3]);
    instrumentToCode(id);
    const interval = url.searchParams.get("interval");
    if (interval !== "1d" && interval !== "1m") throw new GatewayError("INVALID_INTERVAL", "interval 仅支持 1d 或 1m", 400);
    return cached(request, interval === "1d" ? 60 : 10, ctx, () => loadBars(id, interval));
  }
  if (url.pathname === "/api/market/news") {
    const ids = (url.searchParams.get("instruments") ?? "").split(",").filter(Boolean);
    if (ids.length > 20) throw new GatewayError("INVALID_ARGUMENT", "instruments 最多支持 20 个证券代码", 400);
    ids.forEach(instrumentToCode);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "30"), 1), 80);
    return cached(request, 60, ctx, () => loadMarketNews(ids, limit));
  }
  if (url.pathname === "/api/market/announcements") {
    const id = url.searchParams.get("instrument");
    if (!id) throw new GatewayError("INVALID_ARGUMENT", "instrument 是必填参数", 400);
    instrumentToCode(id);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 50);
    return cached(request, 300, ctx, () => loadAnnouncements(id, limit));
  }
  if (url.pathname === "/api/market/status") {
    const exchange = url.searchParams.get("exchange");
    if (exchange !== "SSE" && exchange !== "SZSE") throw new GatewayError("INVALID_EXCHANGE", "exchange 仅支持 SSE 或 SZSE", 400);
    const china = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const weekday = china.getDay();
    const minutes = china.getHours() * 60 + china.getMinutes();
    const open = weekday >= 1 && weekday <= 5 && ((minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900));
    return json({ data: { exchange, open, marketTimestamp: new Date().toISOString(), source: "gateway-calendar", warnings: ["未接入节假日交易日历"] } }, 200, "public, max-age=30");
  }
  throw new GatewayError("NOT_FOUND", "未找到行情接口", 404);
}

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 GET" } }, 405);
    try { return await route(request, ctx); }
    catch (error) {
      const known = error instanceof GatewayError ? error : new GatewayError("INTERNAL_ERROR", "行情网关内部错误", 500);
      const details = error instanceof AllProvidersFailedError ? { attempts: error.attempts } : undefined;
      console.error(JSON.stringify({ event: "market_gateway_error", code: known.code, message: known.message, path: new URL(request.url).pathname, details }));
      return json({ error: { code: known.code, message: known.message, details } }, known.status);
    }
  },
} satisfies ExportedHandler<Env>;
