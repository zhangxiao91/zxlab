import { defaultInstruments } from "../risk/config";
import type { MarketWatchlistItem } from "./types";

const WATCHLIST_KEY = "zxlab.market.watchlist.v1";
export function defaultMarketWatchlist(): MarketWatchlistItem[] {
  return [];
}

export function loadMarketWatchlist(storage: Storage): MarketWatchlistItem[] {
  try {
    const parsed = JSON.parse(storage.getItem(WATCHLIST_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      const items = parsed.map((item) => item && typeof item === "object" ? item as Partial<MarketWatchlistItem> : null).filter((item): item is Partial<MarketWatchlistItem> => Boolean(item));
      const normalized: MarketWatchlistItem[] = items.flatMap((item) => {
        if (typeof item.instrumentId !== "string") return [];
        const normalizedItem = toWatchlistItem(
          item.instrumentId,
          item.reason || "自选标的",
          item.label,
        );
        return normalizedItem ? [normalizedItem] : [];
      });
      if (normalized.length) {
        const migrated = dedup(normalized);
        const oldDefaults = new Set(["SSE:512480", "SZSE:159995", "SSE:513100"]);
        if (migrated.length === oldDefaults.size && migrated.every((item) => oldDefaults.has(item.instrumentId) && item.reason === "当前 Risk 账本默认标的")) return [];
        return migrated;
      }
    }
  } catch {
    return defaultMarketWatchlist();
  }
  return [];
}

export function saveMarketWatchlist(storage: Storage, items: MarketWatchlistItem[]): void {
  storage.setItem(WATCHLIST_KEY, JSON.stringify(dedup(items)));
}

export function toWatchlistItem(instrumentId: string, reason = "自选标的", label?: string): MarketWatchlistItem | null {
  const match = /^(SSE|SZSE):(\d{6})$/.exec(instrumentId.trim().toUpperCase());
  if (!match) return null;
  const instrument = defaultInstruments.find((item) => item.id === match[0]);
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
