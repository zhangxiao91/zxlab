import { getChinaMarketStatus } from "./calendar.ts";
import { projectCachedLoadResult } from "./cache-policy.ts";
import { applyIntradayFreshnessDecision, assessDailyBarFreshness, assessIntradayFreshness } from "./freshness.ts";
import { readCurrentMarketSnapshot, type SnapshotLoadResult } from "./snapshot.ts";
import { DEFAULT_QUOTE_CONFLICT_THRESHOLD_BPS, type MarketFactQuality, type MarketFreshness, type MarketQuoteMode, type MarketReference, type QuoteCorroboration, type TradingCalendar } from "../../../packages/market-schema/src/index.ts";
import type { ResearchFactPlane as ResearchFactPlaneInterface, ResearchFactRequest } from "@zxlab/research-fact-schema";
import { ResearchFactPlane, type DailyHistoryResult } from "./research/fact-plane.ts";
import { StaticVersionedBenchmarkMappingRegistry } from "./research/benchmark-mappings.ts";

type NullableNumber = number | null;
type Quality = MarketFactQuality;
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
  corroboration?: QuoteCorroboration;
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

const QUOTE_CONFLICT_THRESHOLD_BPS = DEFAULT_QUOTE_CONFLICT_THRESHOLD_BPS;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "content-type": "application/json; charset=utf-8",
};
const MAX_UPSTREAM_BYTES = 2_000_000;
const UPSTREAM_TIMEOUT_MS = 4_500;
const QUOTE_BATCH_CONCURRENCY = 4;

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
    : /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? `${text}T00:00:00+08:00`
    : `${text.includes("T") ? text : text.replace(" ", "T")}${hasZone ? "" : "+08:00"}`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function normalizeBarTimestamp(value: string): string | null {
  const compact = /^(\d{8})\s+(\d{4})(\d{2})?$/.exec(value.trim());
  if (compact) return toIso(chinaIso(compact[1], `${compact[2]}${compact[3] ?? "00"}`));
  return toIso(value);
}

function compactText(value: unknown, max = 2_000): string | null {
  if (value == null) return null;
  const text = String(value).replace(/<\/?em\b[^>]*>/gi, "").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

function quoteWarnings(price: number | null, marketTimestamp: string | null): string[] {
  return [
    price == null ? "上游缺少现价" : null,
    marketTimestamp == null ? "上游缺少市场时间" : null,
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
  return { instrumentId, price, previousClose: finite(fields[4]), open: finite(fields[5]), high: finite(fields[33]), low: finite(fields[34]), volume: multiplied(fields[6], 100), turnover: multiplied(fields[37], 10_000), marketTimestamp, receivedAt, source: "tencent-qt", quality: marketTimestamp ? "live" : "stale", stale: marketTimestamp == null, warnings: quoteWarnings(price, marketTimestamp), fallbackUsed: false, providerAttempts: [] };
}

export function parseTencentSecurityName(body: string): string {
  const quoted = body.match(/="([^"]*)"/s)?.[1];
  const name = compactText(quoted?.split("~")[1], 80);
  if (!name) throw new GatewayError("EMPTY_RESPONSE", "腾讯未返回证券简称", 502);
  return name;
}

export function parseSinaQuote(instrumentId: string, body: string, receivedAt = new Date().toISOString()): StandardQuote {
  const quoted = body.match(/="([^"]*)"/s)?.[1];
  if (!quoted) throw new GatewayError("EMPTY_RESPONSE", `新浪未返回 ${instrumentId} 报价`, 502);
  const fields = quoted.split(",");
  if (fields.length < 32) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `新浪报价字段数量异常：${fields.length}`, 502);
  const marketTimestamp = chinaIso(fields[30] ?? "", fields[31] ?? "");
  const price = finite(fields[3]);
  if (price == null) throw new GatewayError("EMPTY_PRICE", `新浪 ${instrumentId} 现价为空`, 502);
  return { instrumentId, price, previousClose: finite(fields[2]), open: finite(fields[1]), high: finite(fields[4]), low: finite(fields[5]), volume: finite(fields[8]), turnover: finite(fields[9]), marketTimestamp, receivedAt, source: "sina-hq", quality: marketTimestamp ? "live" : "stale", stale: marketTimestamp == null, warnings: quoteWarnings(price, marketTimestamp), fallbackUsed: true, providerAttempts: [] };
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
  return { instrumentId, price, previousClose: scaled(data.f60), open: scaled(data.f46), high: scaled(data.f44), low: scaled(data.f45), volume: multiplied(data.f47, 100), turnover: finite(data.f48), marketTimestamp, receivedAt, source: "eastmoney-push2", quality: marketTimestamp ? "live" : "stale", stale: marketTimestamp == null, warnings: quoteWarnings(price, marketTimestamp), fallbackUsed: true, providerAttempts: [] };
}

export function parseEastmoneySecurityName(payload: unknown): string {
  const data = (payload as { data?: Record<string, unknown> | null }).data;
  const name = compactText(data?.f58 ?? data?.f14, 80);
  if (!name) throw new GatewayError("EMPTY_RESPONSE", "东财未返回证券简称", 502);
  return name;
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
  const result = root.result as Record<string, unknown> | undefined;
  const candidates = [
    data?.list,
    data?.news,
    data?.fastNewsList,
    data?.cmsArticleWebOld,
    result?.cmsArticleWebOld,
    root.list,
    root.news,
    root.fastNewsList,
  ];
  const rows = candidates.find((candidate) => Array.isArray(candidate) && candidate.length > 0);
  if (!Array.isArray(rows)) throw new GatewayError("EMPTY_RESPONSE", "东财消息返回空", 502);
  return rows as Record<string, unknown>[];
}

export function parseEastmoneyStockNews(instrumentId: string, payload: unknown): StandardNewsItem[] {
  const { symbol } = instrumentToCode(instrumentId);
  const rows = eastmoneyRows(payload);
  const items = rows.flatMap((row): StandardNewsItem[] => {
    const id = compactText(row.code ?? row.infoCode ?? row.info_code ?? row.artCode ?? row.art_code ?? row.id, 120);
    const title = compactText(row.title ?? row.name, 240);
    const url = compactText(row.url ?? row.artUrl ?? row.art_url ?? row.link, 2_048)
      ?? (id ? `https://finance.eastmoney.com/a/${encodeURIComponent(id)}.html` : null);
    if (!id || !title || !url) return [];
    return [newsItem({ id: `eastmoney-stock:${id}`, type: "stock-news", title, url, summary: row.digest ?? row.summary ?? row.content, content: row.content, source: "eastmoney-stock-news", publishedAt: row.showTime ?? row.show_time ?? row.publishTime ?? row.publish_time ?? row.date, instrumentId, symbol })];
  });
  if (!items.length) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "东财个股新闻字段发生变化", 502);
  return items;
}

export function parseTencentStockNews(instrumentId: string, payload: unknown): StandardNewsItem[] {
  const { symbol } = instrumentToCode(instrumentId);
  const rows = (payload as { data?: { data?: unknown[] } }).data?.data;
  if (!Array.isArray(rows) || !rows.length) throw new GatewayError("EMPTY_RESPONSE", "腾讯个股新闻返回空", 502);
  const items = rows.flatMap((raw): StandardNewsItem[] => {
    const row = raw as Record<string, unknown>;
    const id = compactText(row.id, 120);
    const title = compactText(row.title, 240);
    const url = compactText(row.url, 2_048);
    if (!id || !title || !url) return [];
    const publisher = compactText(row.src, 120);
    const summary = compactText(row.summary) ?? (publisher ? `来源：${publisher}` : null);
    return [newsItem({ id: `tencent-stock:${id}`, type: "stock-news", title, url, summary, source: "tencent-stock-news", publishedAt: row.time ?? row.predictTimestamp, instrumentId, symbol })];
  });
  if (!items.length) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "腾讯个股新闻字段发生变化", 502);
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

export function parseEastmoneyAnnouncements(instrumentId: string, payload: unknown): StandardNewsItem[] {
  const { symbol } = instrumentToCode(instrumentId);
  const rows = (payload as { data?: { list?: unknown[] } }).data?.list;
  if (!Array.isArray(rows)) throw new GatewayError("EMPTY_RESPONSE", "东财公告返回空", 502);
  const items = rows.flatMap((raw): StandardNewsItem[] => {
    const row = raw as Record<string, unknown>;
    const id = compactText(row.art_code ?? row.id, 120);
    const title = compactText(row.title_ch ?? row.title, 240);
    if (!id || !title) return [];
    const columns = Array.isArray(row.columns)
      ? row.columns.map((item) => compactText((item as Record<string, unknown>).column_name, 80)).filter(Boolean).join(" / ")
      : null;
    return [newsItem({
      id: `eastmoney-announcement:${id}`,
      type: "announcement",
      title,
      url: `https://data.eastmoney.com/notices/detail/${symbol}/${id}.html`,
      summary: columns,
      source: "eastmoney-announcement",
      publishedAt: row.notice_date ?? row.display_time,
      instrumentId,
      symbol,
    })];
  });
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
  if (attempts.some((attempt) => attempt.errorCode === "UPSTREAM_SCHEMA_CHANGED")) {
    throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `${capability} 至少一个 Provider 返回不兼容结构`, 502);
  }
  throw new AllProvidersFailedError(capability, attempts);
}

export async function runCorroboratedQuote(providers: Provider<StandardQuote>[], fetcher: Fetcher = fetch, thresholdBps = QUOTE_CONFLICT_THRESHOLD_BPS): Promise<StandardQuote> {
  const attempts: ProviderAttempt[] = [];
  const observations: Array<{ provider: string; quote: StandardQuote }> = [];
  for (const provider of providers) {
    const startedAt = performance.now();
    try {
      const quote = await provider.load(fetcher);
      if (quote.price == null) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `${provider.name} 未返回有效价格`, 502);
      attempts.push({ provider: provider.name, ok: true, latencyMs: Math.round(performance.now() - startedAt), errorCode: null, message: null });
      observations.push({ provider: provider.name, quote });
      if (observations.length === 2) break;
    } catch (error) {
      const known = error instanceof GatewayError ? error : new GatewayError("PROVIDER_ERROR", error instanceof Error ? error.message : "Provider 失败", 502);
      attempts.push({ provider: provider.name, ok: false, latencyMs: Math.round(performance.now() - startedAt), errorCode: known.code, message: known.message });
    }
  }
  if (!observations.length) throw new AllProvidersFailedError("quote", attempts);
  const primary = observations[0];
  const quoteObservations = observations.map((item) => ({ provider: item.provider, price: item.quote.price as number, marketTimestamp: item.quote.marketTimestamp, receivedAt: item.quote.receivedAt }));
  const maxDeviationBps = observations.length >= 2 ? deviationBps(quoteObservations[0].price, quoteObservations[1].price) : null;
  const conflicted = maxDeviationBps != null && maxDeviationBps > thresholdBps;
  const limited = observations.length < 2;
  const warnings = [
    ...primary.quote.warnings,
    ...(limited ? ["corroborated 模式未取得第二个独立报价源"] : []),
    ...(conflicted ? [`独立报价源差异 ${maxDeviationBps.toFixed(1)} bps，超过 ${thresholdBps} bps 阈值`] : []),
  ];
  return {
    ...primary.quote,
    source: primary.provider,
    quality: conflicted ? "conflicted" : primary.quote.quality,
    warnings,
    fallbackUsed: attempts[0]?.ok !== true,
    providerAttempts: attempts,
    corroboration: { mode: "corroborated", status: conflicted ? "conflicted" : limited ? "limited" : "corroborated", thresholdBps, maxDeviationBps, observations: quoteObservations },
  };
}

function deviationBps(left: number, right: number): number {
  const midpoint = (Math.abs(left) + Math.abs(right)) / 2;
  return midpoint === 0 ? 0 : Math.abs(left - right) / midpoint * 10_000;
}

class AllProvidersFailedError extends GatewayError {
  constructor(readonly capability: Capability, readonly attempts: ProviderAttempt[]) { super("ALL_PROVIDERS_FAILED", `${capability} 的 ${attempts.length} 个 Provider 均失败`, 502); }
}

function quoteProviders(instrumentId: string, receivedAt = new Date().toISOString()): Provider<StandardQuote>[] {
  const code = instrumentToCode(instrumentId);
  return [
    { name: "tencent-qt", load: async (fetcher) => parseTencentQuote(instrumentId, await (await upstream(fetcher, `https://qt.gtimg.cn/q=${code.prefixed}`)).text(), receivedAt) },
    { name: "sina-hq", load: async (fetcher) => parseSinaQuote(instrumentId, await (await upstream(fetcher, `https://hq.sinajs.cn/list=${code.prefixed}`, { referer: "https://finance.sina.com.cn/" })).text(), receivedAt) },
    { name: "eastmoney-push2", load: async (fetcher) => parseEastmoneyQuote(instrumentId, await (await upstream(fetcher, `https://push2.eastmoney.com/api/qt/stock/get?secid=${code.secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f86`)).json(), receivedAt) },
  ];
}

function dailyProviders(instrumentId: string): Provider<StandardBar[]>[] {
  const code = instrumentToCode(instrumentId);
  const baiduUrl = `https://finance.pae.baidu.com/selfselect/getstockquotation?all=1&isIndex=false&isBk=false&isBlock=false&isFutures=false&isStock=true&newFormat=1&group=quotation_kline_ab&finClientType=pc&code=${code.symbol}&ktype=1`;
  return [
    { name: "tencent-kline", load: async (fetcher) => parseTencentDailyBars(instrumentId, code.prefixed, await (await upstream(fetcher, `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code.prefixed},day,,,400,qfq`)).json()) },
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
  return [
    {
      name: "tencent-stock-news",
      load: async (fetcher) => parseTencentStockNews(instrumentId, await (await upstream(fetcher, `https://proxy.finance.qq.com/ifzqgtimg/appstock/news/info/search?page=1&symbol=${code.prefixed}&n=${Math.max(10, Math.min(limit, 50))}&type=2`, { referer: `https://gu.qq.com/${code.prefixed}/gp` })).json()),
    },
    {
      name: "eastmoney-stock-news",
      load: async (fetcher) => {
        let name: string;
        try {
          name = parseTencentSecurityName(await (await upstream(fetcher, `https://qt.gtimg.cn/q=${code.prefixed}`)).text());
        } catch {
          name = parseEastmoneySecurityName(await (await upstream(fetcher, `https://push2.eastmoney.com/api/qt/stock/get?secid=${code.secid}&fields=f58`)).json());
        }
        const param = JSON.stringify({
          uid: "",
          keyword: name,
          type: ["cmsArticleWebOld"],
          client: "web",
          clientType: "web",
          clientVersion: "curr",
          param: { cmsArticleWebOld: { searchScope: "default", sort: "default", pageIndex: 1, pageSize: Math.min(limit, 50) } },
        });
        return parseEastmoneyStockNews(instrumentId, await upstreamJsonp(fetcher, `https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery1124&param=${encodeURIComponent(param)}`, { referer: "https://so.eastmoney.com/" }));
      },
    },
  ];
}

function fastNewsProviders(limit: number): Provider<StandardNewsItem[]>[] {
  const trace = crypto.randomUUID();
  return [
    {
      name: "eastmoney-724",
      load: async (fetcher) => parseEastmoneyFastNews(await (await upstream(fetcher, `https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=0&pageSize=${Math.min(limit, 80)}&pageNo=1&req_trace=${encodeURIComponent(trace)}`, { referer: "https://finance.eastmoney.com/" })).json()),
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
    {
      name: "eastmoney-announcement",
      load: async (fetcher) => parseEastmoneyAnnouncements(instrumentId, await (await upstream(fetcher, `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${Math.min(limit, 50)}&page_index=1&ann_type=A&client_source=web&stock_list=${code.symbol}`, { referer: "https://data.eastmoney.com/" })).json()),
    },
  ];
}

function unavailableQuote(instrumentId: string, error: AllProvidersFailedError, mode: MarketQuoteMode): StandardQuote {
  return { instrumentId, price: null, previousClose: null, open: null, high: null, low: null, volume: null, turnover: null, marketTimestamp: null, receivedAt: new Date().toISOString(), source: "unavailable", quality: "unavailable", stale: true, warnings: [error.message, ...error.attempts.map((item) => `${item.provider}: ${item.errorCode}`)], fallbackUsed: true, providerAttempts: error.attempts, corroboration: { mode, status: mode === "fallback" ? "not_requested" : "limited", thresholdBps: QUOTE_CONFLICT_THRESHOLD_BPS, maxDeviationBps: null, observations: [] } };
}

function withQuoteDiagnostics(result: FallbackResult<StandardQuote>): StandardQuote {
  const fallbackWarning = result.fallbackUsed ? [`主源失败，已降级至 ${result.source}`] : [];
  return { ...result.data, source: result.source, fallbackUsed: result.fallbackUsed, providerAttempts: result.attempts, warnings: [...fallbackWarning, ...result.data.warnings], corroboration: { mode: "fallback", status: "not_requested", thresholdBps: QUOTE_CONFLICT_THRESHOLD_BPS, maxDeviationBps: null, observations: [] } };
}

function json(data: unknown, status = 200, cache = "no-store") { return new Response(JSON.stringify(data), { status, headers: { ...CORS, "cache-control": cache } }); }
function privateJson(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }

async function cached<T>(request: Request, seconds: number, ctx: ExecutionContext, loader: () => Promise<LoadResult<T>>) {
  const cache = await caches.open("risk-market-v2");
  const hit = await cache.match(request);
  if (hit) {
    const body = await hit.json() as LoadResult<T>;
    return json(projectCachedLoadResult(body), 200, `public, max-age=${seconds}`);
  }
  const loaded = await loader();
  const response = json({ data: loaded.data, meta: { ...loaded.meta, cached: false } }, 200, `public, max-age=${seconds}`);
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

export interface QuoteLoadDependencies {
  fetcher?: Fetcher;
  now?: () => Date;
  calendar?: TradingCalendar;
}

export async function loadQuotes(ids: string[], mode: MarketQuoteMode = "fallback", dependencies: QuoteLoadDependencies = {}): Promise<LoadResult<StandardQuote[]>> {
  const fetcher = dependencies.fetcher ?? fetch;
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const resolvedWithFreshness = await mapWithConcurrency(ids, QUOTE_BATCH_CONCURRENCY, async (id) => {
    try {
      const providers = quoteProviders(id, observedAt);
      const loaded = mode === "corroborated"
        ? await runCorroboratedQuote(providers, fetcher)
        : withQuoteDiagnostics(await runWithFallback("quote", providers, fetcher));
      const decision = await assessIntradayFreshness({ exchange: instrumentToCode(id).exchange, marketTimestamp: loaded.marketTimestamp, receivedAt: loaded.receivedAt }, dependencies.calendar);
      return { quote: applyIntradayFreshnessDecision(loaded, decision), freshness: decision.freshness, reference: decision.reference };
    } catch (error) {
      if (error instanceof AllProvidersFailedError) return { quote: unavailableQuote(id, error, mode), freshness: "unknown" as const, reference: undefined };
      throw error;
    }
  });
  const resolved = resolvedWithFreshness.map((item) => item.quote);
  const sources = [...new Set(resolved.map((item) => item.source))];
  const unavailableCount = resolved.filter((item) => item.quality === "unavailable").length;
  const receivedAt = resolved.map((item) => item.receivedAt).sort().at(-1) ?? new Date().toISOString();
  const asOf = resolved.map((item) => item.marketTimestamp).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const freshness = aggregateFreshness(resolvedWithFreshness.map((item) => item.freshness));
  const capabilityStatus = unavailableCount === resolved.length ? "unavailable" : unavailableCount > 0 || freshness !== "fresh" || resolved.some((item) => item.fallbackUsed || item.quality !== "live" || item.corroboration?.status === "limited") ? "degraded" : "operational";
  return { data: resolved, meta: { capability: "quote", quoteMode: mode, capabilityStatus, asOf, receivedAt, freshness, reference: commonReference(resolvedWithFreshness.map((item) => item.reference)), providerChain: ["tencent-qt", "sina-hq", "eastmoney-push2"], sources, attempts: resolved.flatMap((item) => item.providerAttempts), warnings: resolved.flatMap((item) => item.warnings), fallbackCount: resolved.filter((item) => item.fallbackUsed).length, unavailableCount, corroboratedCount: resolved.filter((item) => item.corroboration?.status === "corroborated").length, conflictedCount: resolved.filter((item) => item.quality === "conflicted").length } };
}

function aggregateFreshness(values: MarketFreshness[]): MarketFreshness {
  if (!values.length || values.every((value) => value === "unknown")) return "unknown";
  if (values.some((value) => value === "stale")) return "stale";
  if (values.some((value) => value !== "fresh")) return "mixed";
  return "fresh";
}

function commonReference(values: Array<MarketReference | undefined>): MarketReference | undefined {
  const references = values.filter((value): value is MarketReference => Boolean(value));
  if (!references.length) return undefined;
  const canonical = JSON.stringify(references[0]);
  return references.every((reference) => JSON.stringify(reference) === canonical) ? references[0] : undefined;
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

export interface BarLoadDependencies {
  fetcher?: Fetcher;
  now?: () => Date;
  calendar?: TradingCalendar;
}

export async function loadBars(instrumentId: string, interval: "1d" | "1m", dependencies: BarLoadDependencies = {}): Promise<LoadResult<StandardBar[]>> {
  const capability = interval === "1d" ? "daily-bars" : "minute-bars";
  const providers = interval === "1d" ? dailyProviders(instrumentId) : minuteProviders(instrumentId);
  const result = await runWithFallback(capability, providers, dependencies.fetcher ?? fetch);
  const data = result.data.map((item) => {
    const timestamp = normalizeBarTimestamp(item.timestamp);
    if (!timestamp) throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", `${result.source} 返回无法识别的 K 线时间`, 502);
    return { ...item, timestamp };
  });
  const receivedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const asOf = data.map((item) => item.timestamp).sort().at(-1) ?? null;
  const freshness = interval === "1d"
    ? await assessDailyBarFreshness({ exchange: instrumentToCode(instrumentId).exchange, marketTimestamp: asOf, receivedAt }, dependencies.calendar)
    : await assessIntradayFreshness({ exchange: instrumentToCode(instrumentId).exchange, marketTimestamp: asOf, receivedAt }, dependencies.calendar);
  const capabilityStatus = !data.length ? "unavailable" : result.fallbackUsed || freshness.freshness !== "fresh" ? "degraded" : "operational";
  return { data, meta: { capability, capabilityStatus, asOf, receivedAt, freshness: data.length ? freshness.freshness : "unknown", reference: freshness.reference, warnings: freshness.warnings, source: result.source, fallbackUsed: result.fallbackUsed, providerChain: providers.map((item) => item.name), attempts: result.attempts } };
}

export function dedupNews(items: StandardNewsItem[], limit: number): StandardNewsItem[] {
  const seen = new Set<string>();
  const sorted = items.filter((item) => {
    const key = item.url || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => Date.parse(right.publishedAt ?? right.receivedAt) - Date.parse(left.publishedAt ?? left.receivedAt));
  const market = sorted.filter((item) => item.type === "market-news");
  const stock = sorted.filter((item) => item.type === "stock-news");
  if (!market.length || !stock.length) return sorted.slice(0, limit);
  const balanced: StandardNewsItem[] = [];
  const perType = Math.ceil(limit / 2);
  for (let index = 0; index < perType; index += 1) {
    if (market[index]) balanced.push(market[index]);
    if (stock[index]) balanced.push(stock[index]);
  }
  return balanced.slice(0, limit);
}

async function loadAnnouncements(instrumentId: string, limit: number): Promise<LoadResult<StandardNewsItem[]>> {
  const providers = announcementProviders(instrumentId, limit);
  const result = await runWithFallback("announcement", providers);
  return { data: result.data, meta: { capability: "announcement", source: result.source, fallbackUsed: result.fallbackUsed, providerChain: providers.map((item) => item.name), attempts: result.attempts } };
}

async function loadMarketNews(ids: string[], limit: number): Promise<LoadResult<StandardNewsItem[]>> {
  const attempts: ProviderAttempt[] = [];
  const warnings: string[] = [];
  const batches: StandardNewsItem[][] = [];
  const fastLimit = ids.length ? Math.max(1, Math.ceil(limit / 2)) : limit;
  const stockLimit = ids.length ? Math.max(4, Math.floor((limit - fastLimit) / ids.length)) : 0;
  try {
    const result = await runWithFallback("market-news", fastNewsProviders(fastLimit));
    attempts.push(...result.attempts);
    batches.push(result.data);
  } catch (error) {
    const known = error instanceof AllProvidersFailedError ? error : null;
    if (known) attempts.push(...known.attempts);
    warnings.push("eastmoney-724 unavailable");
  }
  for (const id of ids) {
    try {
      const stock = await runWithFallback("stock-news", stockNewsProviders(id, stockLimit));
      attempts.push(...stock.attempts);
      batches.push(stock.data);
    } catch (error) {
      const known = error instanceof AllProvidersFailedError ? error : null;
      if (known) attempts.push(...known.attempts);
      warnings.push(`${id} stock news unavailable`);
    }
  }
  return { data: dedupNews(batches.flat(), limit), meta: { capability: "market-news", providerChain: ["eastmoney-724", "tencent-stock-news", "eastmoney-stock-news"], attempts, warnings } };
}

async function loadStatus(exchange: "SSE" | "SZSE"): Promise<SnapshotLoadResult<Awaited<ReturnType<typeof getChinaMarketStatus>>>> {
  const data = await getChinaMarketStatus(exchange);
  return { data, meta: { capability: `status:${exchange}`, capabilityStatus: data.quality, asOf: data.asOf, receivedAt: data.receivedAt, freshness: data.freshness, reference: data.reference, warnings: data.warnings } };
}

function productionResearchFactPlane(): ResearchFactPlane {
  return new ResearchFactPlane({
    benchmarkMappings: new StaticVersionedBenchmarkMappingRegistry(),
    history: {
      async loadDailyHistory(input) {
        const loaded = await loadBars(input.instrumentId, "1d");
        return projectDailyHistoryForResearch(input.instrumentId, loaded);
      },
    },
  });
}

export function projectDailyHistoryForResearch(instrumentId: string, loaded: LoadResult<StandardBar[]>): DailyHistoryResult {
  if (!loaded.data.length || loaded.data.some((bar) => !Number.isFinite(bar.close) || !Number.isFinite(bar.volume))) {
    throw new GatewayError("UPSTREAM_SCHEMA_CHANGED", "Daily history contains invalid required fields", 502);
  }
  const provider = typeof loaded.meta.source === "string" ? loaded.meta.source : "risk-market-daily-bars";
  const retrievedAt = typeof loaded.meta.receivedAt === "string" ? loaded.meta.receivedAt : new Date().toISOString();
  const warnings = Array.isArray(loaded.meta.warnings) ? loaded.meta.warnings.filter((item): item is string => typeof item === "string") : [];
  if (loaded.meta.fallbackUsed === true) warnings.push("PROVIDER_FALLBACK_USED");
  return {
    instrumentId,
    provider,
    providerVersion: "risk-market-daily-bars.v1",
    retrievedAt,
    bars: loaded.data.map((bar) => ({
      sessionDate: bar.timestamp.slice(0, 10),
      close: String(bar.close),
      volume: String(bar.volume),
      turnover: typeof bar.turnover === "number" ? String(bar.turnover) : null,
    })),
    warnings,
  };
}

export async function handleResearchFactRequest(request: Request, serviceToken: string | undefined, plane: ResearchFactPlaneInterface): Promise<Response> {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!serviceToken || provided !== serviceToken) return privateJson({ error: { code: "UNAUTHORIZED", message: "Market research service token is required" } }, 401);
  if (request.method !== "POST") return privateJson({ error: { code: "METHOD_NOT_ALLOWED", message: "Research facts require POST" } }, 405);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 32_768) return privateJson({ error: { code: "PAYLOAD_TOO_LARGE", message: "Research fact request exceeds 32768 bytes" } }, 413);
  let payload: unknown;
  try {
    const body = await request.text();
    if (body.length > 32_768) return privateJson({ error: { code: "PAYLOAD_TOO_LARGE", message: "Research fact request exceeds 32768 bytes" } }, 413);
    payload = JSON.parse(body);
  } catch {
    return privateJson({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } }, 400);
  }
  try {
    const data = await plane.materialize(payload as ResearchFactRequest);
    return privateJson({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("Invalid ResearchFactRequest:")) return privateJson({ error: { code: "INVALID_RESEARCH_FACT_REQUEST", message } }, 400);
    if (message === "UNSUPPORTED_RESEARCH_PURPOSE") return privateJson({ error: { code: message, message: "Research purpose is not implemented" } }, 422);
    if (message === "OBSERVATION_CUTOFF_OUT_OF_RANGE") return privateJson({ error: { code: message, message: "observationCutoff must be within the previous 15 minutes", retryable: false } }, 400);
    if (message === "RESEARCH_HISTORY_INTEGRITY_FAILURE") return privateJson({ error: { code: message, message: "Research history failed integrity validation", retryable: false } }, 502);
    console.error(JSON.stringify({ event: "research_fact_error", code: "RESEARCH_FACT_MATERIALIZATION_FAILED", path: new URL(request.url).pathname }));
    return privateJson({ error: { code: "RESEARCH_FACT_MATERIALIZATION_FAILED", message: "Research facts could not be materialized" } }, 502);
  }
}

async function route(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/api/market/providers") return json({ data: { quote: ["tencent-qt", "sina-hq", "eastmoney-push2"], dailyBars: ["tencent-kline", "baidu-gushitong", "tonghuashun-kline"], minuteBars: ["tencent-minute", "sina-minute", "eastmoney-trends"], news: ["eastmoney-724", "tencent-stock-news", "eastmoney-stock-news", "cninfo-announcement", "eastmoney-announcement"], strategy: "sequential-fallback", timeoutMsPerProvider: UPSTREAM_TIMEOUT_MS } }, 200, "public, max-age=300");
  if (url.pathname === "/api/market/snapshot") {
    const ids = uniqueQuery(url.searchParams.get("ids"));
    if (!ids.length || ids.length > 10) throw new GatewayError("INVALID_ARGUMENT", "ids 需要包含 1 至 10 个证券代码", 400);
    ids.forEach(instrumentToCode);
    const include = uniqueQuery(url.searchParams.get("include") || "quotes,bars");
    if (!include.length || include.some((item) => !["quotes", "bars", "news", "announcements", "comparisons"].includes(item))) throw new GatewayError("INVALID_ARGUMENT", "include 包含不支持的 capability", 400);
    const intervals = uniqueQuery(url.searchParams.get("intervals") || "1m");
    if (!intervals.length || intervals.some((item) => item !== "1d" && item !== "1m")) throw new GatewayError("INVALID_INTERVAL", "intervals 仅支持 1d 或 1m", 400);
    const quoteMode = url.searchParams.get("quoteMode") || "fallback";
    if (quoteMode !== "fallback" && quoteMode !== "corroborated") throw new GatewayError("INVALID_ARGUMENT", "quoteMode 仅支持 fallback 或 corroborated", 400);
    const data = await readCurrentMarketSnapshot({ instrumentIds: ids, include: include as Array<"quotes" | "bars" | "news" | "announcements" | "comparisons">, intervals: intervals as Array<"1d" | "1m">, quoteMode }, {
      loadQuotes,
      loadBars,
      loadNews: loadMarketNews,
      loadAnnouncements,
      loadStatus,
      now: () => new Date().toISOString(),
    });
    return json({ data, meta: { schemaVersion: data.schemaVersion, asOf: data.asOf, receivedAt: data.receivedAt, capabilityStatus: data.quality.status, freshness: data.quality.freshness, warnings: data.quality.warnings, attempts: data.quality.attempts } }, 200, "no-store");
  }
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
    const loaded = await loadStatus(exchange);
    return json(loaded, 200, "public, max-age=30");
  }
  throw new GatewayError("NOT_FOUND", "未找到行情接口", 404);
}

function uniqueQuery(value: string | null): string[] { return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))]; }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/api/market/research/facts") return handleResearchFactRequest(request, (env as Env & { MARKET_RESEARCH_TOKEN?: string }).MARKET_RESEARCH_TOKEN, productionResearchFactPlane());
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "仅支持 GET" } }, 405);
    if (new URL(request.url).pathname === "/internal/runtime/health") {
      const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!env.ZX_RUNTIME_SERVICE_TOKEN || provided !== env.ZX_RUNTIME_SERVICE_TOKEN) return json({ error: { code: "UNAUTHORIZED", message: "Runtime service token is required" } }, 401);
      const generatedAt = new Date().toISOString();
      return json({ schemaVersion: "1", serviceId: "market", status: "operational", version: "risk-market-worker", generatedAt, checks: [{ id: "worker", status: "operational", lastSuccessAt: generatedAt }] });
    }
    try { return await route(request, ctx); }
    catch (error) {
      const known = error instanceof GatewayError ? error : new GatewayError("INTERNAL_ERROR", "行情网关内部错误", 500);
      const details = error instanceof AllProvidersFailedError ? { attempts: error.attempts } : undefined;
      const cause = error instanceof Error && !(error instanceof GatewayError) ? error.message : undefined;
      console.error(JSON.stringify({ event: "market_gateway_error", code: known.code, message: known.message, cause, path: new URL(request.url).pathname, details }));
      return json({ error: { code: known.code, message: known.message, details } }, known.status);
    }
  },
} satisfies ExportedHandler<Env>;
