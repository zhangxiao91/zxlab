export type QuoteQuality = "live" | "cached" | "stale" | "unavailable";

export interface MarketQuote {
  instrumentId: string;
  price: number | null;
  previousClose: number | null;
  marketTimestamp: string | null;
  receivedAt: string;
  source: string;
  quality: QuoteQuality;
  stale: boolean;
  warnings: string[];
}

export interface MarketStatus {
  exchange: "SSE" | "SZSE";
  open: boolean;
  marketTimestamp: string;
  source: string;
  warnings: string[];
}

export interface MarketClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getJson(options: MarketClientOptions, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const url = new URL(path, options.baseUrl);
    const response = await (options.fetcher ?? fetch)(url, {
      headers: { accept: "application/json", "user-agent": "zxlab-bot-bridge/0.2" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ZXLab Market API returned HTTP ${response.status}.`);
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function parseQuote(value: unknown): MarketQuote {
  if (!isRecord(value) || typeof value.instrumentId !== "string" ||
    (typeof value.price !== "number" && value.price !== null) ||
    (typeof value.previousClose !== "number" && value.previousClose !== null) ||
    (typeof value.marketTimestamp !== "string" && value.marketTimestamp !== null) ||
    typeof value.receivedAt !== "string" || typeof value.source !== "string" ||
    !["live", "cached", "stale", "unavailable"].includes(String(value.quality)) ||
    typeof value.stale !== "boolean" || !Array.isArray(value.warnings)) {
    throw new Error("ZXLab Market API returned an invalid quote.");
  }
  return {
    instrumentId: value.instrumentId,
    price: value.price,
    previousClose: value.previousClose,
    marketTimestamp: value.marketTimestamp,
    receivedAt: value.receivedAt,
    source: value.source,
    quality: value.quality as QuoteQuality,
    stale: value.stale,
    warnings: value.warnings.filter((item): item is string => typeof item === "string"),
  };
}

export async function fetchMarketQuotes(options: MarketClientOptions, instrumentIds: string[]): Promise<MarketQuote[]> {
  const params = new URLSearchParams({ instruments: instrumentIds.join(",") });
  const value = await getJson(options, `/api/market/quotes?${params}`);
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("ZXLab Market API returned an invalid quote envelope.");
  return value.data.map(parseQuote);
}

export async function fetchMarketStatus(
  options: MarketClientOptions,
  exchange: "SSE" | "SZSE",
): Promise<MarketStatus> {
  const value = await getJson(options, `/api/market/status?exchange=${exchange}`);
  if (!isRecord(value) || !isRecord(value.data) || value.data.exchange !== exchange ||
    typeof value.data.open !== "boolean" || typeof value.data.marketTimestamp !== "string" ||
    typeof value.data.source !== "string" || !Array.isArray(value.data.warnings)) {
    throw new Error("ZXLab Market API returned an invalid status.");
  }
  return {
    exchange,
    open: value.data.open,
    marketTimestamp: value.data.marketTimestamp,
    source: value.data.source,
    warnings: value.data.warnings.filter((item): item is string => typeof item === "string"),
  };
}
