export type MarketQuality = "live" | "cached" | "stale" | "unavailable";
export type MarketExchange = "SSE" | "SZSE";
export type MarketInterval = "1d" | "1m";

export interface MarketProviderAttempt {
  provider: string;
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
  message: string | null;
}

export interface MarketQuote {
  instrumentId: string;
  price: number | null;
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  turnover: number | null;
  marketTimestamp: string | null;
  receivedAt: string;
  source: string;
  quality: MarketQuality;
  stale: boolean;
  warnings: string[];
  fallbackUsed?: boolean;
  providerAttempts?: MarketProviderAttempt[];
}

export interface MarketBar {
  instrumentId: string;
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  turnover: number | null;
  source?: string;
}

export interface MarketNewsItem {
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

export interface MarketStatus {
  exchange: string;
  open: boolean;
  marketTimestamp: string | null;
  source: string;
  warnings?: string[];
}

export interface MarketProviders {
  quote: string[];
  dailyBars: string[];
  minuteBars: string[];
  news: string[];
  strategy: string;
  timeoutMsPerProvider: number;
}

export interface MarketResponse<T> {
  data: T;
  meta?: {
    capability?: string;
    source?: string;
    sources?: string[];
    fallbackUsed?: boolean;
    fallbackCount?: number;
    unavailableCount?: number;
    providerChain?: string[];
    attempts?: MarketProviderAttempt[];
    warnings?: string[];
    cached?: boolean;
    [key: string]: unknown;
  };
}

export interface MarketWatchlistItem {
  instrumentId: string;
  label: string;
  symbol: string;
  exchange: MarketExchange;
  reason: string;
}
