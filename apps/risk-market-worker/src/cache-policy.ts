import type { MarketCapabilityStatus, MarketFactQuality, MarketFreshness } from "../../../packages/market-schema/src/index.ts";

export interface CacheableLoadResult<T> {
  data: T;
  meta: Record<string, unknown>;
}

export function projectCachedLoadResult<T>(result: CacheableLoadResult<T>): CacheableLoadResult<T> {
  if (!Array.isArray(result.data)) return { data: result.data, meta: { ...result.meta, cached: true } };

  const data = result.data.map((item) => {
    if (!isQualityItem(item)) return item;
    return item.quality === "live" ? { ...item, quality: "cached" as const } : item;
  });
  const qualities = data.filter(isQualityItem).map((item) => item.quality);
  if (!qualities.length) return { data: data as T, meta: { ...result.meta, cached: true } };

  return {
    data: data as T,
    meta: {
      ...result.meta,
      cached: true,
      capabilityStatus: worseCapabilityStatus(
        marketCapabilityStatus(result.meta.capabilityStatus),
        intrinsicCapabilityStatus(qualities),
      ),
      freshness: cachedFreshness(qualities, result.meta.freshness),
    },
  };
}

function intrinsicCapabilityStatus(qualities: MarketFactQuality[]): MarketCapabilityStatus {
  if (qualities.every((quality) => quality === "unavailable")) return "unavailable";
  return qualities.some((quality) => quality === "stale" || quality === "conflicted" || quality === "unavailable")
    ? "degraded"
    : "operational";
}

function worseCapabilityStatus(left: MarketCapabilityStatus, right: MarketCapabilityStatus): MarketCapabilityStatus {
  const rank: Record<MarketCapabilityStatus, number> = { operational: 0, degraded: 1, unavailable: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function cachedFreshness(qualities: MarketFactQuality[], original: unknown): MarketFreshness {
  if (qualities.every((quality) => quality === "unavailable")) return "unknown";
  if (qualities.some((quality) => quality === "stale")) return "stale";
  if (qualities.some((quality) => quality === "unavailable")) return "mixed";
  return isMarketFreshness(original) ? original : "unknown";
}

function isQualityItem(value: unknown): value is Record<string, unknown> & { quality: MarketFactQuality } {
  if (!value || typeof value !== "object" || !("quality" in value)) return false;
  return ["live", "cached", "stale", "conflicted", "unavailable"].includes(String((value as { quality?: unknown }).quality));
}

function isMarketFreshness(value: unknown): value is MarketFreshness {
  return value === "fresh" || value === "mixed" || value === "stale" || value === "unknown";
}

function marketCapabilityStatus(value: unknown): MarketCapabilityStatus {
  return value === "operational" || value === "degraded" || value === "unavailable" ? value : "operational";
}
