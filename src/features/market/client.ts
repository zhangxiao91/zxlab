import type { MarketBar, MarketExchange, MarketInterval, MarketNewsItem, MarketProviders, MarketQuote, MarketResponse, MarketStatus } from "./types";
import { parseMarketSnapshot, type MarketSnapshot, type MarketSnapshotRequest } from "../../../packages/market-schema/src/index";

export class MarketDataError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly details?: unknown) {
    super(message);
    this.name = "MarketDataError";
  }
}

export class MarketClient {
  constructor(
    private readonly baseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.PUBLIC_RISK_MARKET_API_URL || "",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getQuotes(instrumentIds: string[], signal?: AbortSignal): Promise<MarketResponse<MarketQuote[]>> {
    return this.request(`/api/market/quotes?instruments=${encodeURIComponent(instrumentIds.join(","))}`, signal);
  }

  async getSnapshot(input: MarketSnapshotRequest, signal?: AbortSignal): Promise<MarketResponse<MarketSnapshot>> {
    const params = new URLSearchParams({ ids: input.instrumentIds.join(","), include: input.include.join(","), intervals: input.intervals.join(","), quoteMode: input.quoteMode });
    const response = await this.request<unknown>(`/api/market/snapshot?${params}`, signal);
    return { data: parseMarketSnapshot(response.data), meta: response.meta };
  }

  async getBars(instrumentId: string, interval: MarketInterval, signal?: AbortSignal): Promise<MarketResponse<MarketBar[]>> {
    return this.request(`/api/market/bars/${encodeURIComponent(instrumentId)}?interval=${interval}`, signal);
  }

  async getStatus(exchange: MarketExchange, signal?: AbortSignal): Promise<MarketResponse<MarketStatus>> {
    return this.request(`/api/market/status?exchange=${exchange}`, signal);
  }

  async getProviders(signal?: AbortSignal): Promise<MarketResponse<MarketProviders>> {
    return this.request("/api/market/providers", signal);
  }

  async getNews(instrumentIds: string[], limit = 30, signal?: AbortSignal): Promise<MarketResponse<MarketNewsItem[]>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (instrumentIds.length) params.set("instruments", instrumentIds.join(","));
    return this.request(`/api/market/news?${params}`, signal);
  }

  async getAnnouncements(instrumentId: string, limit = 20, signal?: AbortSignal): Promise<MarketResponse<MarketNewsItem[]>> {
    return this.request(`/api/market/announcements?instrument=${encodeURIComponent(instrumentId)}&limit=${limit}`, signal);
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<MarketResponse<T>> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(15_000);
      response = await this.fetcher.call(globalThis, `${this.baseUrl.replace(/\/$/, "")}${path}`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new MarketDataError(error instanceof Error ? error.message : "行情中心不可达", "MARKET_CENTER_UNREACHABLE");
    }
    const body = await response.json().catch(() => null) as { data?: T; meta?: MarketResponse<T>["meta"]; error?: { code?: string; message?: string; details?: unknown } } | null;
    if (!response.ok || !body || body.data === undefined) {
      throw new MarketDataError(body?.error?.message || `行情中心返回 ${response.status}`, body?.error?.code || "MARKET_CENTER_ERROR", response.status, body?.error?.details);
    }
    return { data: body.data, meta: body.meta };
  }
}

export const defaultMarketClient = new MarketClient();
