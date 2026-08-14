import type { MarketCapabilityStatus, MarketFreshness, MarketSnapshot } from "@zxlab/market-schema";

export interface QuotePriceChange {
  kind: "quote_price";
  instrumentId: string;
  previous: number;
  current: number;
  delta: number;
  deltaBps: number | null;
}

export interface MarketSnapshotDiff {
  previousAsOf: string;
  currentAsOf: string;
  changes: MarketSnapshotChange[];
}

export type SnapshotQualityChange =
  | { kind: "snapshot_quality"; field: "status"; previous: MarketCapabilityStatus; current: MarketCapabilityStatus }
  | { kind: "snapshot_quality"; field: "reliable"; previous: boolean; current: boolean }
  | { kind: "snapshot_quality"; field: "freshness"; previous: MarketFreshness; current: MarketFreshness };

export type CapabilityChange =
  | { kind: "capability"; capabilityId: string; field: "status"; previous: MarketCapabilityStatus; current: MarketCapabilityStatus }
  | { kind: "capability"; capabilityId: string; field: "freshness"; previous: MarketFreshness; current: MarketFreshness };

export type AddedItemChange =
  | { kind: "news_added"; itemId: string }
  | { kind: "announcement_added"; itemId: string };

export type MarketSnapshotChange = QuotePriceChange | SnapshotQualityChange | CapabilityChange | AddedItemChange;

export function diffMarketSnapshots(previous: MarketSnapshot, current: MarketSnapshot): MarketSnapshotDiff {
  const previousPrices = new Map(
    previous.data.quotes.map((quote) => [quote.instrumentId, quote.price] as const),
  );
  const changes: MarketSnapshotChange[] = [];

  for (const quote of [...current.data.quotes].sort((left, right) => left.instrumentId.localeCompare(right.instrumentId))) {
    const previousPrice = previousPrices.get(quote.instrumentId);
    if (typeof previousPrice !== "number" || typeof quote.price !== "number" || previousPrice === quote.price) continue;
    changes.push({
      kind: "quote_price",
      instrumentId: quote.instrumentId,
      previous: previousPrice,
      current: quote.price,
      delta: quote.price - previousPrice,
      deltaBps: previousPrice === 0 ? null : Math.round(((quote.price - previousPrice) / previousPrice) * 10_000),
    });
  }

  if (previous.quality.status !== current.quality.status) {
    changes.push({ kind: "snapshot_quality", field: "status", previous: previous.quality.status, current: current.quality.status });
  }
  if (previous.quality.reliable !== current.quality.reliable) {
    changes.push({ kind: "snapshot_quality", field: "reliable", previous: previous.quality.reliable, current: current.quality.reliable });
  }
  if (previous.quality.freshness !== current.quality.freshness) {
    changes.push({ kind: "snapshot_quality", field: "freshness", previous: previous.quality.freshness, current: current.quality.freshness });
  }

  const previousCapabilities = new Map(previous.capabilities.map((capability) => [capability.id, capability] as const));
  for (const capability of [...current.capabilities].sort((left, right) => left.id.localeCompare(right.id))) {
    const previousCapability = previousCapabilities.get(capability.id);
    if (!previousCapability) continue;
    if (previousCapability.status !== capability.status) {
      changes.push({ kind: "capability", capabilityId: capability.id, field: "status", previous: previousCapability.status, current: capability.status });
    }
    if (previousCapability.freshness !== capability.freshness) {
      changes.push({ kind: "capability", capabilityId: capability.id, field: "freshness", previous: previousCapability.freshness, current: capability.freshness });
    }
  }

  const previousNewsIds = new Set(previous.data.news.map((item) => item.id));
  for (const itemId of addedIds(current.data.news.map((item) => item.id), previousNewsIds)) {
    changes.push({ kind: "news_added", itemId });
  }
  const previousAnnouncementIds = new Set(previous.data.announcements.map((item) => item.id));
  for (const itemId of addedIds(current.data.announcements.map((item) => item.id), previousAnnouncementIds)) {
    changes.push({ kind: "announcement_added", itemId });
  }

  return { previousAsOf: previous.asOf, currentAsOf: current.asOf, changes };
}

function addedIds(currentIds: string[], previousIds: Set<string>): string[] {
  return [...new Set(currentIds)].filter((itemId) => !previousIds.has(itemId)).sort();
}
