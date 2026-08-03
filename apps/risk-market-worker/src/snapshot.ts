import {
  MARKET_SNAPSHOT_SCHEMA_VERSION,
  DEFAULT_QUOTE_CONFLICT_THRESHOLD_BPS,
  parseMarketSnapshot,
  type MarketBar,
  type MarketCapabilityHealth,
  type MarketCapabilityStatus,
  type MarketExchange,
  type MarketFreshness,
  type MarketNewsItem,
  type MarketProviderAttempt,
  type MarketQuote,
  type MarketSnapshot,
  type MarketSnapshotQuote,
  type MarketSnapshotRequest,
  type MarketStatus,
} from "../../../packages/market-schema/src/index.ts";

export interface SnapshotLoadResult<T> {
  data: T;
  meta: Record<string, unknown>;
}

export interface SnapshotReaderDependencies {
  loadQuotes(ids: string[], mode: MarketSnapshotRequest["quoteMode"]): Promise<SnapshotLoadResult<MarketQuote[]>>;
  loadBars(id: string, interval: "1d" | "1m"): Promise<SnapshotLoadResult<MarketBar[]>>;
  loadNews(ids: string[], limit: number): Promise<SnapshotLoadResult<MarketNewsItem[]>>;
  loadAnnouncements(id: string, limit: number): Promise<SnapshotLoadResult<MarketNewsItem[]>>;
  loadStatus(exchange: MarketExchange): Promise<SnapshotLoadResult<MarketStatus>>;
  now(): string;
}

type LoadedCapability =
  | { kind: "quotes"; id: string; result: SnapshotLoadResult<MarketQuote[]> }
  | { kind: "bars"; id: string; instrumentId: string; interval: "1d" | "1m"; result: SnapshotLoadResult<MarketBar[]> }
  | { kind: "news"; id: string; result: SnapshotLoadResult<MarketNewsItem[]> }
  | { kind: "announcements"; id: string; result: SnapshotLoadResult<MarketNewsItem[]> }
  | { kind: "status"; id: string; result: SnapshotLoadResult<MarketStatus> }
  | { kind: "failed"; id: string; error: unknown };

export async function readCurrentMarketSnapshot(request: MarketSnapshotRequest, dependencies: SnapshotReaderDependencies): Promise<MarketSnapshot> {
  const observedAt = dependencies.now();
  const tasks: Array<() => Promise<LoadedCapability>> = [];
  if (request.include.includes("quotes")) tasks.push(() => safe("quotes", "quotes", () => dependencies.loadQuotes(request.instrumentIds, request.quoteMode)));
  if (request.include.includes("bars")) {
    for (const instrumentId of request.instrumentIds) for (const interval of request.intervals) {
      const id = `bars:${instrumentId}:${interval}`;
      tasks.push(() => safeBars(id, instrumentId, interval, () => dependencies.loadBars(instrumentId, interval)));
    }
  }
  if (request.include.includes("news")) tasks.push(() => safe("news", "news", () => dependencies.loadNews(request.instrumentIds, 36)));
  if (request.include.includes("announcements")) {
    for (const instrumentId of request.instrumentIds) tasks.push(() => safe("announcements", `announcements:${instrumentId}`, () => dependencies.loadAnnouncements(instrumentId, 20)));
  }
  const exchanges = [...new Set(request.instrumentIds.map((id) => id.split(":")[0]).filter((value): value is MarketExchange => value === "SSE" || value === "SZSE"))];
  for (const exchange of exchanges.length ? exchanges : ["SSE", "SZSE"] as const) tasks.push(() => safe("status", `status:${exchange}`, () => dependencies.loadStatus(exchange)));

  const loaded = await runTasks(tasks, 4);
  const quotes = loaded.flatMap((item) => item.kind === "quotes" ? item.result.data : []).map((quote): MarketSnapshotQuote => ({
    ...quote,
    corroboration: quote.corroboration ?? {
      mode: request.quoteMode,
      status: request.quoteMode === "fallback" ? "not_requested" : "limited",
      thresholdBps: DEFAULT_QUOTE_CONFLICT_THRESHOLD_BPS,
      maxDeviationBps: null,
      observations: [],
    },
    warnings: request.quoteMode === "corroborated" && !quote.corroboration
      ? unique([...quote.warnings, "corroborated 模式缺少交叉验证结果"])
      : quote.warnings,
  }));
  const bars = loaded.flatMap((item) => item.kind === "bars" ? [{ instrumentId: item.instrumentId, interval: item.interval, bars: item.result.data }] : []);
  const news = loaded.flatMap((item) => item.kind === "news" ? item.result.data : []);
  const announcements = loaded.flatMap((item) => item.kind === "announcements" ? item.result.data : []);
  const status = loaded.flatMap((item) => item.kind === "status" ? [item.result.data] : []);
  const capabilities = loaded.map((item) => capabilityOf(item, observedAt));
  if (request.include.includes("comparisons")) capabilities.push({ id: "comparisons", status: "unavailable", required: true, asOf: null, receivedAt: observedAt, freshness: "unknown", warnings: ["comparisons capability 尚未配置 benchmark mapping"], attempts: [] });

  const required = capabilities.filter((item) => item.required);
  const requiredFacts = required.filter((item) => !item.id.startsWith("status:"));
  const unavailableCapabilities = required.filter((item) => item.status === "unavailable").map((item) => item.id);
  const quoteUnreliable = quotes.some((quote) => quote.quality === "stale" || quote.quality === "conflicted" || quote.quality === "unavailable" || quote.corroboration?.status === "limited");
  const calendarUnreliable = status.some((item) => !item.reliable);
  const reliable = required.length > 0 && unavailableCapabilities.length === 0 && !quoteUnreliable && !calendarUnreliable;
  const qualityStatus: MarketCapabilityStatus = requiredFacts.length > 0 && requiredFacts.every((item) => item.status === "unavailable") ? "unavailable" : required.some((item) => item.status !== "operational") || !reliable ? "degraded" : "operational";
  const freshness: MarketFreshness = quotes.some((item) => item.quality === "stale") ? "stale" : qualityStatus === "operational" ? "fresh" : required.some((item) => item.status === "operational") ? "mixed" : "unknown";
  const warnings = unique([...capabilities.flatMap((item) => item.warnings), ...quotes.flatMap((item) => item.warnings), ...status.flatMap((item) => item.warnings)]);
  const attempts = capabilities.flatMap((item) => item.attempts);
  const marketTimestamp = latest([
    ...quotes.map((item) => item.marketTimestamp),
    ...bars.flatMap((series) => series.bars.map((bar) => bar.timestamp)),
  ]);
  const receivedAt = dependencies.now();
  return parseMarketSnapshot({
    schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
    asOf: observedAt,
    receivedAt,
    marketTimestamp,
    request,
    data: { quotes, bars, news, announcements, status },
    capabilities,
    quality: { status: qualityStatus, reliable, freshness, warnings, attempts, unavailableCapabilities },
  });
}

function capabilityOf(item: LoadedCapability, observedAt: string): MarketCapabilityHealth {
  if (item.kind === "failed") return { id: item.id, status: "unavailable", required: true, asOf: null, receivedAt: observedAt, freshness: "unknown", warnings: [errorText(item.error)], attempts: errorAttempts(item.error) };
  const meta = item.result.meta;
  const warnings = strings(meta.warnings);
  const attempts = providerAttempts(meta.attempts);
  let status = capabilityStatus(meta.capabilityStatus) ?? (warnings.length || attempts.some((attempt) => !attempt.ok) || meta.fallbackUsed === true ? "degraded" : "operational");
  let freshness = marketFreshness(meta.freshness) ?? "fresh";
  if (item.kind === "quotes") {
    if (!item.result.data.length || item.result.data.every((quote) => quote.quality === "unavailable")) status = "unavailable";
    else if (item.result.data.some((quote) => quote.quality !== "live" || quote.corroboration?.status === "limited")) status = "degraded";
    if (item.result.data.some((quote) => quote.quality === "stale")) freshness = "stale";
  }
  if (item.kind === "bars" && !item.result.data.length) { status = "unavailable"; freshness = "unknown"; }
  if (item.kind === "status" && !item.result.data.reliable) { status = "degraded"; freshness = "unknown"; }
  return { id: item.id, status, required: true, asOf: optionalString(meta.asOf), receivedAt: optionalString(meta.receivedAt) ?? observedAt, freshness, warnings: unique([...warnings, ...(item.kind === "status" ? item.result.data.warnings : [])]), attempts };
}

async function safe<K extends "quotes" | "news" | "announcements" | "status", T>(kind: K, id: string, load: () => Promise<SnapshotLoadResult<T>>): Promise<LoadedCapability> {
  try { return { kind, id, result: await load() } as LoadedCapability; }
  catch (error) { return { kind: "failed", id, error }; }
}

async function safeBars(id: string, instrumentId: string, interval: "1d" | "1m", load: () => Promise<SnapshotLoadResult<MarketBar[]>>): Promise<LoadedCapability> {
  try { return { kind: "bars", id, instrumentId, interval, result: await load() }; }
  catch (error) { return { kind: "failed", id, error }; }
}

function providerAttempts(value: unknown): MarketProviderAttempt[] { return Array.isArray(value) ? value.filter((item): item is MarketProviderAttempt => Boolean(item) && typeof item === "object" && typeof (item as MarketProviderAttempt).provider === "string") : []; }
function errorAttempts(error: unknown): MarketProviderAttempt[] { return error && typeof error === "object" && "attempts" in error ? providerAttempts((error as { attempts?: unknown }).attempts) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function optionalString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function capabilityStatus(value: unknown): MarketCapabilityStatus | null { return value === "operational" || value === "degraded" || value === "unavailable" ? value : null; }
function marketFreshness(value: unknown): MarketFreshness | null { return value === "fresh" || value === "mixed" || value === "stale" || value === "unknown" ? value : null; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "capability unavailable"; }
function latest(values: Array<string | null>): string | null { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

async function runTasks(tasks: Array<() => Promise<LoadedCapability>>, concurrency: number): Promise<LoadedCapability[]> {
  const results = new Array<LoadedCapability>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}
