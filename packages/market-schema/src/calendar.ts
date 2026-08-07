import type { MarketDay, MarketExchange, MarketSession, TradingCalendar } from "./index.ts";

export interface ChinaMarketStatus {
  exchange: MarketExchange;
  open: boolean | null;
  session: MarketSession;
  calendarDate: string;
  marketTimestamp: string;
  asOf: string;
  receivedAt: string;
  freshness: "fresh" | "unknown";
  quality: "operational" | "degraded";
  reliable: boolean;
  source: string;
  warnings: string[];
}

export interface CalendarClosure { date: string; kind: "holiday" | "temporary"; label: string; }
export interface OfficialCalendarFixture { start: string; end: string; source: string; closures: CalendarClosure[]; }

const OFFICIAL_2026: OfficialCalendarFixture = {
  start: "2026-01-01", end: "2026-12-31", source: "sse-calendar-2026",
  closures: [
    { date: "2026-01-01", kind: "holiday", label: "元旦" }, { date: "2026-01-02", kind: "holiday", label: "元旦" },
    { date: "2026-02-16", kind: "holiday", label: "春节" }, { date: "2026-02-17", kind: "holiday", label: "春节" }, { date: "2026-02-18", kind: "holiday", label: "春节" }, { date: "2026-02-19", kind: "holiday", label: "春节" }, { date: "2026-02-20", kind: "holiday", label: "春节" }, { date: "2026-02-23", kind: "holiday", label: "春节" },
    { date: "2026-04-06", kind: "holiday", label: "清明节" }, { date: "2026-05-01", kind: "holiday", label: "劳动节" }, { date: "2026-05-04", kind: "holiday", label: "劳动节" }, { date: "2026-05-05", kind: "holiday", label: "劳动节" },
    { date: "2026-06-19", kind: "holiday", label: "端午节" }, { date: "2026-09-25", kind: "holiday", label: "中秋节" },
    { date: "2026-10-01", kind: "holiday", label: "国庆节" }, { date: "2026-10-02", kind: "holiday", label: "国庆节" }, { date: "2026-10-05", kind: "holiday", label: "国庆节" }, { date: "2026-10-06", kind: "holiday", label: "国庆节" }, { date: "2026-10-07", kind: "holiday", label: "国庆节" },
  ],
};

export class OfficialCnTradingCalendar implements TradingCalendar {
  private readonly closures: Map<string, CalendarClosure>;
  constructor(private readonly fixture: OfficialCalendarFixture = OFFICIAL_2026) { this.closures = new Map(fixture.closures.map((item) => [item.date, item])); }
  async getMarketDay(market: "CN", date: string): Promise<MarketDay> {
    if (market !== "CN" || !isDate(date) || date < this.fixture.start || date > this.fixture.end) return { status: "unknown", source: this.fixture.source, reliable: false, warnings: [`正式交易日历不覆盖 ${date}`] };
    const closure = this.closures.get(date);
    if (closure || dayOfWeek(date) === 0 || dayOfWeek(date) === 6) return { status: "holiday", source: this.fixture.source, reliable: true, warnings: closure?.kind === "temporary" ? [`临时休市：${closure.label}`] : [] };
    return { status: "trading_day", source: this.fixture.source, reliable: true, warnings: [] };
  }
}

export class WeekdayFallbackTradingCalendar implements TradingCalendar {
  async getMarketDay(_market: "CN", date: string): Promise<MarketDay> { const weekday = isDate(date) && dayOfWeek(date) >= 1 && dayOfWeek(date) <= 5; return { status: "unknown", source: "weekday-fallback", reliable: false, warnings: [`${date} 不在正式交易日历覆盖范围；工作日近似为 ${weekday ? "可能交易日" : "可能休市日"}，不得用于确定性开闭市判断`] }; }
}

export class FallbackTradingCalendar implements TradingCalendar {
  constructor(private readonly primary: TradingCalendar, private readonly fallback: TradingCalendar) {}
  async getMarketDay(market: "CN", date: string): Promise<MarketDay> { const result = await this.primary.getMarketDay(market, date); return result.status === "unknown" ? this.fallback.getMarketDay(market, date) : result; }
}

export class CachedTradingCalendar implements TradingCalendar {
  private readonly values = new Map<string, Promise<MarketDay>>();
  constructor(private readonly inner: TradingCalendar) {}
  getMarketDay(market: "CN", date: string): Promise<MarketDay> { const key = `${market}:${date}`; const existing = this.values.get(key); if (existing) return existing; const pending = this.inner.getMarketDay(market, date).catch((error) => { this.values.delete(key); throw error; }); this.values.set(key, pending); return pending; }
}

export const productionTradingCalendar: TradingCalendar = new CachedTradingCalendar(new FallbackTradingCalendar(new OfficialCnTradingCalendar(), new WeekdayFallbackTradingCalendar()));

export async function getChinaMarketStatus(exchange: MarketExchange, now = new Date(), calendar: TradingCalendar = productionTradingCalendar): Promise<ChinaMarketStatus> {
  const receivedAt = now.toISOString(); const parts = shanghaiParts(now); const calendarDate = `${parts.year}-${parts.month}-${parts.day}`; const marketDay = await calendar.getMarketDay("CN", calendarDate); const minutes = Number(parts.hour) * 60 + Number(parts.minute); const timedSession = sessionAt(minutes); const session: MarketSession = marketDay.status === "unknown" ? "unknown" : marketDay.status === "holiday" ? "holiday" : timedSession;
  return { exchange, open: marketDay.status === "unknown" ? null : marketDay.status === "trading_day" && timedSession === "open", session, calendarDate, marketTimestamp: receivedAt, asOf: receivedAt, receivedAt, freshness: marketDay.reliable ? "fresh" : "unknown", quality: marketDay.reliable ? "operational" : "degraded", reliable: marketDay.reliable, source: marketDay.source, warnings: marketDay.warnings };
}

function sessionAt(minutes: number): MarketSession { if (minutes >= 555 && minutes < 570) return "preopen"; if ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900)) return "open"; if (minutes >= 690 && minutes < 780) return "break"; return "closed"; }
function isDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function dayOfWeek(value: string) { return new Date(`${value}T00:00:00Z`).getUTCDay(); }
function shanghaiParts(date: Date): Record<"year" | "month" | "day" | "hour" | "minute", string> { return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value])) as Record<"year" | "month" | "day" | "hour" | "minute", string>; }
