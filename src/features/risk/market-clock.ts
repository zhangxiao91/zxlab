import type { Quote } from "./types";

export type MarketSnapshotStatus = "live" | "closed-snapshot" | "stale" | "unavailable";

export function isChinaTradingSession(value: string): boolean {
  const parts = chinaParts(value);
  if (!parts || parts.weekday === 6 || parts.weekday === 7) return false;
  const minute = parts.hour * 60 + parts.minute;
  return (minute >= 9 * 60 + 30 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60);
}

export function blockingStaleQuotes(quotes: Quote[], now: string): Quote[] {
  if (!isChinaTradingSession(now)) return [];
  return quotes.filter((item) => item.stale || item.quality === "stale");
}

export function marketSnapshotStatus(quotes: Quote[], now: string): MarketSnapshotStatus {
  if (!quotes.length || quotes.some((item) => item.quality === "unavailable" || item.price == null)) return "unavailable";
  if (blockingStaleQuotes(quotes, now).length) return "stale";
  if (quotes.some((item) => item.stale || item.quality === "stale")) return "closed-snapshot";
  return "live";
}

export function marketFreshnessText(status: MarketSnapshotStatus, sources: string[], fallbackCount: number): string {
  const sourceText = sources.join(" / ") || "无可用源";
  const fallbackText = fallbackCount ? ` · ${fallbackCount} 项降级` : "";
  if (status === "closed-snapshot") return `闭市快照 · ${sourceText}${fallbackText}`;
  if (status === "stale") return `盘中行情过期 · ${sourceText}${fallbackText}`;
  if (status === "unavailable") return "无可用报价";
  return `盘中实时 · ${sourceText}${fallbackText}`;
}

function chinaParts(value: string): { weekday: number; hour: number; minute: number } | null {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday") ?? "") + 1;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return weekday && Number.isFinite(hour) && Number.isFinite(minute) ? { weekday, hour, minute } : null;
}
