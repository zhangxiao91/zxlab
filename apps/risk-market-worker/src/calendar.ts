export type MarketSession = "preopen" | "open" | "break" | "closed" | "holiday";

export interface ChinaMarketStatus {
  exchange: "SSE" | "SZSE";
  open: boolean;
  session: MarketSession;
  calendarDate: string;
  marketTimestamp: string;
  asOf: string;
  receivedAt: string;
  freshness: "fresh";
  quality: "operational" | "degraded";
  reliable: boolean;
  source: string;
  warnings: string[];
}

const CALENDAR_START = "2026-01-01";
const CALENDAR_END = "2026-12-31";
const OFFICIAL_SOURCE = "sse-calendar-2026";

// 上证公告〔2025〕45号；深交所 2026 年安排采用相同境内休市日期。
const HOLIDAYS_2026 = new Set([
  "2026-01-01", "2026-01-02",
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
  "2026-04-06",
  "2026-05-01", "2026-05-04", "2026-05-05",
  "2026-06-19",
  "2026-09-25",
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
]);

export function getChinaMarketStatus(exchange: "SSE" | "SZSE", now = new Date()): ChinaMarketStatus {
  const receivedAt = now.toISOString();
  const parts = shanghaiParts(now);
  const calendarDate = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${calendarDate}T00:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const covered = calendarDate >= CALENDAR_START && calendarDate <= CALENDAR_END;
  const holiday = covered && HOLIDAYS_2026.has(calendarDate);
  const tradingDay = !weekend && !holiday;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const timedSession = sessionAt(minutes);
  const session = holiday ? "holiday" : tradingDay ? timedSession : "closed";
  const reliable = covered;

  return {
    exchange,
    open: tradingDay && timedSession === "open",
    session,
    calendarDate,
    marketTimestamp: receivedAt,
    asOf: receivedAt,
    receivedAt,
    freshness: "fresh",
    quality: reliable ? "operational" : "degraded",
    reliable,
    source: reliable ? OFFICIAL_SOURCE : "weekday-fallback",
    warnings: reliable ? [] : [`官方交易日历仅覆盖 ${CALENDAR_START} 至 ${CALENDAR_END}，当前使用工作日近似`],
  };
}

function sessionAt(minutes: number): MarketSession {
  if (minutes >= 555 && minutes < 570) return "preopen";
  if ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900)) return "open";
  if (minutes >= 690 && minutes < 780) return "break";
  return "closed";
}

function shanghaiParts(date: Date): Record<"year" | "month" | "day" | "hour" | "minute", string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}
