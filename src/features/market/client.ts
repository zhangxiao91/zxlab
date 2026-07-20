import type { MarketBar, MarketExchange, MarketInterval, MarketNewsItem, MarketProviders, MarketQuote, MarketResponse, MarketStatus } from "./types";

export class MarketDataError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "MarketDataError";
  }
}

export class MarketClient {
  constructor(
    private readonly baseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.PUBLIC_RISK_MARKET_API_URL || "",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getQuotes(instrumentIds: string[]): Promise<MarketResponse<MarketQuote[]>> {
    return this.request(`/api/market/quotes?instruments=${encodeURIComponent(instrumentIds.join(","))}`);
  }

  async getBars(instrumentId: string, interval: MarketInterval): Promise<MarketResponse<MarketBar[]>> {
    return this.request(`/api/market/bars/${encodeURIComponent(instrumentId)}?interval=${interval}`);
  }

  async getStatus(exchange: MarketExchange): Promise<MarketResponse<MarketStatus>> {
    return this.request(`/api/market/status?exchange=${exchange}`);
  }

  async getProviders(): Promise<MarketResponse<MarketProviders>> {
    return this.request("/api/market/providers");
  }

  async getNews(instrumentIds: string[], limit = 30): Promise<MarketResponse<MarketNewsItem[]>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (instrumentIds.length) params.set("instruments", instrumentIds.join(","));
    return this.request(`/api/market/news?${params}`);
  }

  async getAnnouncements(instrumentId: string, limit = 20): Promise<MarketResponse<MarketNewsItem[]>> {
    return this.request(`/api/market/announcements?instrument=${encodeURIComponent(instrumentId)}&limit=${limit}`);
  }

  private async request<T>(path: string): Promise<MarketResponse<T>> {
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, `${this.baseUrl.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new MarketDataError(error instanceof Error ? error.message : "行情中心不可达", "MARKET_CENTER_UNREACHABLE");
    }
    const body = await response.json().catch(() => null) as { data?: T; meta?: MarketResponse<T>["meta"]; error?: { code?: string; message?: string } } | null;
    if (!response.ok || !body || body.data === undefined) {
      throw new MarketDataError(body?.error?.message || `行情中心返回 ${response.status}`, body?.error?.code || "MARKET_CENTER_ERROR", response.status);
    }
    return { data: body.data, meta: body.meta };
  }
}

export const defaultMarketClient = new MarketClient();
