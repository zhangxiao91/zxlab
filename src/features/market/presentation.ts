import type { MarketQuote, MarketStatus } from "./types";

export type MarketPresentationTone = "live" | "cached" | "stale" | "conflicted" | "unavailable";

export function quoteQualityPresentation(quote?: Pick<MarketQuote, "quality">): { label: string; tone: MarketPresentationTone } {
  if (!quote) return { label: "缺报价", tone: "unavailable" };
  if (quote.quality === "live") return { label: "实时", tone: "live" };
  if (quote.quality === "cached") return { label: "缓存", tone: "cached" };
  if (quote.quality === "stale") return { label: "过期", tone: "stale" };
  if (quote.quality === "conflicted") return { label: "源冲突", tone: "conflicted" };
  return { label: "不可用", tone: "unavailable" };
}

export function marketStatusPresentation(status: Pick<MarketStatus, "open" | "session" | "reliable">): string {
  if (!status.reliable || status.session === "unknown" || status.open === null) return "交易状态未知";
  if (status.session === "preopen") return "盘前集合竞价";
  if (status.session === "break") return "午间休市";
  if (status.session === "holiday") return "节假日休市";
  return status.open ? "开市" : "休市";
}
