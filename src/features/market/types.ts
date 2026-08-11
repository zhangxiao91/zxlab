import type {
  MarketBar as SharedMarketBar,
  MarketCapabilityHealth as SharedMarketCapabilityHealth,
  MarketCapabilityStatus,
  MarketExchange,
  MarketFactQuality,
  MarketFreshness,
  MarketInterval,
  MarketNewsItem as SharedMarketNewsItem,
  MarketProviderAttempt as SharedMarketProviderAttempt,
  MarketQuote as SharedMarketQuote,
  MarketSession,
  MarketStatus as SharedMarketStatus,
} from "../../../packages/market-schema/src/index";

export type MarketQuality = MarketFactQuality;
export type { MarketCapabilityStatus, MarketExchange, MarketFreshness, MarketInterval, MarketSession };

export interface MarketProviderAttempt extends SharedMarketProviderAttempt {}

export interface MarketQuote extends SharedMarketQuote {}

export interface MarketBar extends SharedMarketBar {}

export interface MarketNewsItem extends SharedMarketNewsItem {}

export interface MarketStatus extends SharedMarketStatus {}

export interface MarketCapabilityHealth extends Omit<SharedMarketCapabilityHealth, "receivedAt"> {
  receivedAt: string | null;
}

export interface MarketDataQuality {
  status: MarketCapabilityStatus;
  reliable: boolean;
  asOf: string | null;
  receivedAt: string;
  freshness: MarketFreshness;
  capabilities: MarketCapabilityHealth[];
  warnings: string[];
  attempts: MarketProviderAttempt[];
  unavailableCapabilities: string[];
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
    asOf?: string | null;
    receivedAt?: string;
    freshness?: MarketFreshness;
    capabilityStatus?: MarketCapabilityStatus;
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
