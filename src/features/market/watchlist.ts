import { instruments } from "../risk/mock";
import type { MarketWatchlistItem } from "./types";

const WATCHLIST_KEY = "zxlab.market.watchlist.v1";
const DEFAULT_IDS = ["SSE:512480", "SZSE:159995", "SSE:513100"];

export function defaultMarketWatchlist(): MarketWatchlistItem[] {
  return DEFAULT_IDS.map((instrumentId) => toWatchlistItem(instrumentId, "当前 Risk 账本默认标的")).filter((item): item is MarketWatchlistItem => Boolean(item));
}

export function loadMarketWatchlist(storage: Storage): MarketWatchlistItem[] {
  try {
    const parsed = JSON.parse(storage.getItem(WATCHLIST_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      const items = parsed.map((item) => item && typeof item === "object" ? item as Partial<MarketWatchlistItem> : null).filter((item): item is Partial<MarketWatchlistItem> => Boolean(item));
      const normalized = items.flatMap((item) => typeof item.instrumentId === "string" ? [toWatchlistItem(item.instrumentId, item.reason || "自选标的", item.label)] : []);
      if (normalized.length) return dedup(normalized);
    }
  } catch {
    return defaultMarketWatchlist();
  }
  return defaultMarketWatchlist();
}

export function saveMarketWatchlist(storage: Storage, items: MarketWatchlistItem[]): void {
  storage.setItem(WATCHLIST_KEY, JSON.stringify(dedup(items)));
}

export function toWatchlistItem(instrumentId: string, reason = "自选标的", label?: string): MarketWatchlistItem | null {
  const match = /^(SSE|SZSE):(\d{6})$/.exec(instrumentId.trim().toUpperCase());
  if (!match) return null;
  const instrument = instruments.find((item) => item.id === match[0]);
  return {
    instrumentId: match[0],
    exchange: match[1] as "SSE" | "SZSE",
    symbol: match[2],
    label: label || instrument?.name || match[2],
    reason,
  };
}

function dedup(items: MarketWatchlistItem[]): MarketWatchlistItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.instrumentId)) return false;
    seen.add(item.instrumentId);
    return true;
  });
}
