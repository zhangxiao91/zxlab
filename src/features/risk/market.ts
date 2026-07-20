import { MarketClient, MarketDataError as SharedMarketDataError } from "../market/client";
import type { MarketBar, MarketNewsItem, MarketProviders, MarketStatus } from "../market/types";
import { mockQuotes } from "./mock";
import type { Quote } from "./types";

export interface MarketDataProvider {
  readonly name: string;
  getQuotes(instrumentIds: string[]): Promise<Quote[]>;
  getBars(instrumentId: string, interval: "1d" | "1m"): Promise<MarketBar[]>;
  getStatus(exchange: "SSE" | "SZSE"): Promise<MarketStatus>;
  getProviders?(): Promise<MarketProviders>;
  getNews?(instrumentIds: string[], limit?: number): Promise<MarketNewsItem[]>;
  getAnnouncements?(instrumentId: string, limit?: number): Promise<MarketNewsItem[]>;
}

export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = "MockMarketDataProvider";
  async getQuotes(instrumentIds: string[]) { return mockQuotes.filter((quote) => instrumentIds.includes(quote.instrumentId)); }
  async getBars() { return []; }
  async getStatus(exchange: "SSE" | "SZSE") { return { exchange, open: true, marketTimestamp: "2026-07-18T14:32:10+08:00", source: "mock-market" }; }
}

export class MarketDataError extends SharedMarketDataError {}

export class ApiMarketDataProvider implements MarketDataProvider {
  readonly name = "ApiMarketDataProvider";
  private readonly client: MarketClient;
  constructor(baseUrl = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.PUBLIC_RISK_MARKET_API_URL || "", fetcher: typeof fetch = fetch) {
    this.client = new MarketClient(baseUrl, fetcher);
  }
  async getQuotes(instrumentIds: string[]): Promise<Quote[]> { return (await this.client.getQuotes(instrumentIds)).data as Quote[]; }
  async getBars(instrumentId: string, interval: "1d" | "1m"): Promise<MarketBar[]> { return (await this.client.getBars(instrumentId, interval)).data; }
  async getStatus(exchange: "SSE" | "SZSE") { return (await this.client.getStatus(exchange)).data; }
  async getProviders() { return (await this.client.getProviders()).data; }
  async getNews(instrumentIds: string[], limit = 30) { return (await this.client.getNews(instrumentIds, limit)).data; }
  async getAnnouncements(instrumentId: string, limit = 20) { return (await this.client.getAnnouncements(instrumentId, limit)).data; }
}
