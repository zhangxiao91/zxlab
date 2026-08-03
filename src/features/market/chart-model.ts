import type { MarketBar } from "./types";

export type MarketChartKind = "candlestick" | "line" | "empty";

export function resolveMarketChartKind(bars: MarketBar[]): MarketChartKind {
  const ohlcCount = bars.filter((item) => item.open != null && item.high != null && item.low != null && item.close != null).length;
  if (ohlcCount >= 2) return "candlestick";
  const closeCount = bars.filter((item) => item.close != null).length;
  return closeCount >= 2 ? "line" : "empty";
}
