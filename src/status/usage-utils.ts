import type { DailyUsagePoint } from "./types";

export type UsageRange = 7 | 30 | 90;
export interface HeatmapDay { date: string; tokens: number | null; level: 0 | 1 | 2 | 3 | 4; }

const dayMs = 86_400_000;
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const utcDate = (value: string) => new Date(`${value}T00:00:00Z`);

export function sortDailyUsage(points: DailyUsagePoint[]) {
  return [...points]
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.tokens))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function usageForRange(points: DailyUsagePoint[], days: UsageRange, end = new Date()) {
  const threshold = dateKey(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - (days - 1) * dayMs));
  return sortDailyUsage(points).filter((point) => point.date >= threshold && point.date <= dateKey(end));
}

export function formatCompactNumber(value: number | null) {
  if (value === null) return "Unavailable";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function intensityThresholds(points: DailyUsagePoint[]) {
  const values = points.map((point) => point.tokens).filter((value) => value > 0).sort((a, b) => a - b);
  if (!values.length) return [0, 0, 0];
  const quantile = (position: number) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * position))];
  return [quantile(.25), quantile(.5), quantile(.75)];
}

export function usageIntensity(tokens: number | null, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
  if (tokens === null || tokens === 0) return 0;
  if (tokens <= thresholds[0]) return 1;
  if (tokens <= thresholds[1]) return 2;
  if (tokens <= thresholds[2]) return 3;
  return 4;
}

export function buildHeatmap(points: DailyUsagePoint[]): HeatmapDay[] {
  const sorted = sortDailyUsage(points);
  if (!sorted.length) return [];
  const values = new Map(sorted.map((point) => [point.date, point.tokens]));
  const last = utcDate(sorted.at(-1)!.date);
  const earliestAllowed = new Date(last.valueOf() - 364 * dayMs);
  const firstData = utcDate(sorted[0].date);
  const first = firstData > earliestAllowed ? firstData : earliestAllowed;
  const weekday = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.valueOf() - weekday * dayMs);
  const thresholds = intensityThresholds(sorted);
  const cells: HeatmapDay[] = [];
  for (let cursor = start; cursor <= last; cursor = new Date(cursor.valueOf() + dayMs)) {
    const date = dateKey(cursor);
    const tokens = values.get(date) ?? null;
    cells.push({ date, tokens, level: usageIntensity(tokens, thresholds) });
  }
  return cells;
}

export function chartGeometry(points: DailyUsagePoint[], width = 960, height = 280) {
  const sorted = sortDailyUsage(points);
  if (!sorted.length) return { path: "", area: "", points: [] as Array<DailyUsagePoint & { x: number; y: number }> };
  const max = Math.max(1, ...sorted.map((point) => point.tokens));
  const mapped = sorted.map((point, index) => ({
    ...point,
    x: sorted.length === 1 ? width / 2 : index / (sorted.length - 1) * width,
    y: height - (point.tokens / max) * (height - 18) - 9,
  }));
  const path = mapped.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  return { path, area: `${path} L${mapped.at(-1)!.x.toFixed(1)},${height} L${mapped[0].x.toFixed(1)},${height} Z`, points: mapped };
}
