import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";

interface MarketNewsItem {
  id?: string;
  title?: string;
  url?: string;
  summary?: string;
  content?: string;
  source?: string;
  publishedAt?: string;
  instrumentId?: string;
  symbol?: string;
  type?: string;
}

export function transformMarketNews(value: unknown): RawCollectedItem[] {
  const items = (value as { data?: unknown[] }).data;
  if (!Array.isArray(items)) throw new SignalError("INVALID_SOURCE_RESPONSE", "Market news response was invalid", 502);
  return items.flatMap((raw): RawCollectedItem[] => {
    const item = raw as MarketNewsItem;
    if (!item.id || !item.title || !item.url) return [];
    return [{
      externalId: item.id,
      title: item.title,
      url: item.url,
      summary: item.summary,
      contentText: item.content,
      publishedAt: item.publishedAt,
      metadata: { source: item.source, instrumentId: item.instrumentId, symbol: item.symbol, type: item.type },
    }];
  });
}

export class MarketNewsCollector implements SignalCollector {
  readonly type = "market-news" as const;
  constructor(private readonly endpoint?: string, private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!this.endpoint && !source.url) throw new SignalError("SOURCE_DISABLED", "Market news source requires ZX_SIGNAL_MARKET_NEWS_URL or source.url", 409);
    const base = new URL(source.url ?? this.endpoint!);
    base.searchParams.set("limit", String(source.maxItemsPerRun));
    const topics = source.topics ?? [];
    if (topics.length) base.searchParams.set("instruments", topics.join(","));
    const response = await fetchSource(this.fetcher, base.toString(), {
      headers: { Accept: "application/json" },
      expectedTypes: ["application/json"],
      timeoutMs: 15_000,
    });
    return transformMarketNews(await response.json()).slice(0, source.maxItemsPerRun);
  }
}
