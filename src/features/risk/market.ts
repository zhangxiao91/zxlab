import { mockQuotes } from "./mock";
import type { MarketBar, Quote } from "./types";

export interface MarketDataProvider {
  readonly name: string;
  getQuotes(instrumentIds: string[]): Promise<Quote[]>;
  getBars(instrumentId: string, interval: "1d" | "1m"): Promise<MarketBar[]>;
  getStatus(exchange: "SSE" | "SZSE"): Promise<{ exchange: string; open: boolean; marketTimestamp: string | null; source: string }>;
}

export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = "MockMarketDataProvider";
  async getQuotes(instrumentIds: string[]) { return mockQuotes.filter((quote) => instrumentIds.includes(quote.instrumentId)); }
  async getBars() { return []; }
  async getStatus(exchange: "SSE" | "SZSE") { return { exchange, open: true, marketTimestamp: "2026-07-18T14:32:10+08:00", source: "mock-market" }; }
}

export class MarketDataError extends Error { constructor(message: string, readonly code: string) { super(message); } }

export class ApiMarketDataProvider implements MarketDataProvider {
  readonly name = "ApiMarketDataProvider";
  constructor(private readonly baseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.PUBLIC_RISK_MARKET_API_URL || "") {}
  async getQuotes(instrumentIds: string[]): Promise<Quote[]> { return this.request(`/api/market/quotes?instruments=${encodeURIComponent(instrumentIds.join(","))}`); }
  async getBars(instrumentId: string, interval: "1d" | "1m"): Promise<MarketBar[]> { return this.request(`/api/market/bars/${encodeURIComponent(instrumentId)}?interval=${interval}`); }
  async getStatus(exchange: "SSE" | "SZSE") { return this.request<{ exchange: string; open: boolean; marketTimestamp: string | null; source: string }>(`/api/market/status?exchange=${exchange}`); }
  private async request<T>(path: string): Promise<T> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(12_000) }); }
    catch (error) { throw new MarketDataError(error instanceof Error ? error.message : "行情网关不可达", "GATEWAY_UNREACHABLE"); }
    const body = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!response.ok || !body?.data) throw new MarketDataError(body?.error?.message || `行情网关返回 ${response.status}`, body?.error?.code || "UPSTREAM_ERROR");
    return body.data;
  }
}
