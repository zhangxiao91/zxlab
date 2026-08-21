import type {
  MarketExchange,
  MarketFactQuality,
  MarketFreshness,
  MarketReference,
  MarketSession,
  TradingCalendar,
} from "../../../packages/market-schema/src/index.ts";
import { getChinaMarketStatus, productionTradingCalendar } from "./calendar.ts";

export interface IntradayFreshnessInput {
  exchange: MarketExchange;
  marketTimestamp: string | null;
  receivedAt: string;
}

export interface IntradayFreshnessDecision {
  freshness: MarketFreshness;
  stale: boolean;
  session: MarketSession;
  expectedCloseDate: string | null;
  ageSeconds: number;
  warnings: string[];
  reference: MarketReference;
}

export type DailyBarFreshnessDecision = IntradayFreshnessDecision;

export interface IntradayFreshnessFact {
  quality: MarketFactQuality;
  stale: boolean;
  warnings: string[];
}

const CLOSE_TOLERANCE_SECONDS = 120;
const MAX_TRADING_DAY_LOOKBACK = 31;

export async function assessIntradayFreshness(
  input: IntradayFreshnessInput,
  calendar: TradingCalendar = productionTradingCalendar,
): Promise<IntradayFreshnessDecision> {
  const received = new Date(input.receivedAt);
  const market = input.marketTimestamp ? new Date(input.marketTimestamp) : null;
  const status = await getChinaMarketStatus(input.exchange, received, calendar);
  const ageSeconds = market && !Number.isNaN(market.valueOf()) && !Number.isNaN(received.valueOf())
    ? Math.max(0, (received.valueOf() - market.valueOf()) / 1_000)
    : Number.POSITIVE_INFINITY;

  if (!status.reliable || status.session === "unknown") {
    return {
      freshness: "unknown",
      stale: true,
      session: "unknown",
      expectedCloseDate: null,
      ageSeconds,
      warnings: unique([...status.warnings, "交易日历状态未知，无法确认行情新鲜度"]),
      reference: status.reference,
    };
  }

  if (status.session === "holiday") {
    const expectedCloseDate = status.reference.effectiveTradingDate;
    const fresh = expectedCloseDate != null
      && input.marketTimestamp != null
      && isEffectiveCloseObservation(input.marketTimestamp, input.receivedAt, expectedCloseDate);
    return {
      freshness: fresh ? "fresh" : expectedCloseDate ? "stale" : "unknown",
      stale: !fresh,
      session: status.session,
      expectedCloseDate,
      ageSeconds,
      warnings: fresh ? status.warnings : unique([...status.warnings, expectedCloseDate
        ? `最近有效收盘应为 ${expectedCloseDate} 15:00`
        : "无法定位最近一个可靠交易日"]),
      reference: status.reference,
    };
  }

  if (status.session === "preopen") {
    const expectedCloseDate = status.reference.effectiveTradingDate;
    const timelyAuction = input.marketTimestamp != null
      && isSameShanghaiDate(input.marketTimestamp, status.calendarDate)
      && isTimely(input.marketTimestamp, input.receivedAt);
    const previousClose = expectedCloseDate != null
      && input.marketTimestamp != null
      && isEffectiveCloseObservation(input.marketTimestamp, input.receivedAt, expectedCloseDate);
    const fresh = timelyAuction || previousClose;
    return {
      freshness: fresh ? "fresh" : expectedCloseDate ? "stale" : "unknown",
      stale: !fresh,
      session: status.session,
      expectedCloseDate,
      ageSeconds,
      warnings: fresh ? [] : [expectedCloseDate
        ? `盘前行情既非实时集合竞价，也非 ${expectedCloseDate} 15:00 的最近有效收盘`
        : "无法定位盘前最近一个可靠交易日"],
      reference: status.reference,
    };
  }

  if (status.session === "open") {
    const fresh = input.marketTimestamp != null
      && isSameShanghaiDate(input.marketTimestamp, status.calendarDate)
      && isTimely(input.marketTimestamp, input.receivedAt);
    return {
      freshness: fresh ? "fresh" : "stale",
      stale: !fresh,
      session: status.session,
      expectedCloseDate: null,
      ageSeconds,
      warnings: fresh ? [] : [`连续交易阶段行情已延迟 ${formatAge(ageSeconds)}`],
      reference: status.reference,
    };
  }

  if (status.session === "break") {
    const fresh = input.marketTimestamp != null
      && isSessionClose(input.marketTimestamp, status.calendarDate, 11 * 60 + 30);
    return {
      freshness: fresh ? "fresh" : "stale",
      stale: !fresh,
      session: status.session,
      expectedCloseDate: status.calendarDate,
      ageSeconds,
      warnings: fresh ? [] : ["午休阶段最近有效行情应为当日 11:30 的早盘收盘"],
      reference: status.reference,
    };
  }

  if (status.session === "closed") {
    const expectedCloseDate = status.reference.effectiveTradingDate;
    const fresh = expectedCloseDate != null
      && input.marketTimestamp != null
      && isEffectiveCloseObservation(input.marketTimestamp, input.receivedAt, expectedCloseDate);
    return {
      freshness: fresh ? "fresh" : expectedCloseDate ? "stale" : "unknown",
      stale: !fresh,
      session: status.session,
      expectedCloseDate,
      ageSeconds,
      warnings: fresh ? [] : [expectedCloseDate
        ? `闭市阶段最近有效收盘应为 ${expectedCloseDate} 15:00`
        : "无法定位闭市阶段最近一个可靠交易日"],
      reference: status.reference,
    };
  }

  return {
    freshness: "unknown",
    stale: true,
    session: status.session,
    expectedCloseDate: null,
    ageSeconds,
    warnings: ["当前交易时段的新鲜度规则尚未匹配"],
    reference: status.reference,
  };
}

export async function assessDailyBarFreshness(
  input: IntradayFreshnessInput,
  calendar: TradingCalendar = productionTradingCalendar,
): Promise<DailyBarFreshnessDecision> {
  const received = new Date(input.receivedAt);
  const market = input.marketTimestamp ? new Date(input.marketTimestamp) : null;
  const status = await getChinaMarketStatus(input.exchange, received, calendar);
  const ageSeconds = market && !Number.isNaN(market.valueOf()) && !Number.isNaN(received.valueOf())
    ? Math.max(0, (received.valueOf() - market.valueOf()) / 1_000)
    : Number.POSITIVE_INFINITY;
  if (!status.reliable || status.session === "unknown") {
    return { freshness: "unknown", stale: true, session: "unknown", expectedCloseDate: null, ageSeconds, warnings: unique([...status.warnings, "交易日历状态未知，无法确认日 K 新鲜度"]), reference: status.reference };
  }

  const barDate = input.marketTimestamp ? shanghaiDate(input.marketTimestamp) : null;
  let expectedCloseDate: string | null;
  let acceptableDates: string[];
  if (status.session === "holiday") {
    expectedCloseDate = status.reference.effectiveTradingDate;
    acceptableDates = expectedCloseDate ? [expectedCloseDate] : [];
  } else if (status.session === "closed" && (shanghaiMinutes(input.receivedAt) ?? 0) >= 15 * 60) {
    expectedCloseDate = status.reference.effectiveTradingDate;
    acceptableDates = [status.calendarDate];
  } else {
    expectedCloseDate = await previousTradingDate(status.calendarDate, calendar);
    acceptableDates = expectedCloseDate ? [expectedCloseDate] : [];
    if (status.session === "open" || status.session === "break") acceptableDates.push(status.calendarDate);
  }
  const fresh = barDate != null && acceptableDates.includes(barDate);
  const freshness: MarketFreshness = fresh ? "fresh" : expectedCloseDate ? "stale" : "unknown";
  return {
    freshness,
    stale: !fresh,
    session: status.session,
    expectedCloseDate,
    ageSeconds,
    warnings: fresh ? status.warnings : unique([...status.warnings, expectedCloseDate
      ? `日 K 最新有效交易日应为 ${expectedCloseDate}`
      : "无法定位日 K 最近一个可靠交易日"]),
    reference: status.reference,
  };
}

export function applyIntradayFreshnessDecision<T extends IntradayFreshnessFact>(
  fact: T,
  decision: IntradayFreshnessDecision,
): T {
  const preservedQuality = fact.quality === "conflicted" || fact.quality === "unavailable";
  const quality = preservedQuality ? fact.quality : decision.freshness === "fresh" ? "live" : "stale";
  const warnings = fact.warnings.filter((warning) => !/^报价已过期 \d+ 秒$/.test(warning));
  return {
    ...fact,
    quality,
    stale: decision.freshness !== "fresh",
    warnings: unique([
      ...warnings,
      ...decision.warnings,
    ]),
  };
}

function isSameDayPostCloseObservation(marketTimestamp: string, receivedAt: string, date: string): boolean {
  const market = Date.parse(marketTimestamp);
  const received = Date.parse(receivedAt);
  const minutes = shanghaiMinutes(marketTimestamp);
  return Number.isFinite(market)
    && Number.isFinite(received)
    && market <= received
    && isSameShanghaiDate(marketTimestamp, date)
    && minutes !== null
    && minutes >= 15 * 60;
}

function isEffectiveCloseObservation(marketTimestamp: string, receivedAt: string, date: string): boolean {
  return isSessionClose(marketTimestamp, date, 15 * 60)
    || isSameDayPostCloseObservation(marketTimestamp, receivedAt, date);
}

async function previousTradingDate(date: string, calendar: TradingCalendar): Promise<string | null> {
  let candidate = date;
  for (let count = 0; count < MAX_TRADING_DAY_LOOKBACK; count += 1) {
    candidate = previousDate(candidate);
    const day = await calendar.getMarketDay("CN", candidate);
    if (!day.reliable || day.status === "unknown") return null;
    if (day.status === "trading_day") return candidate;
  }
  return null;
}

function previousDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function isSessionClose(value: string, date: string, minutes: number): boolean {
  const timestamp = Date.parse(value);
  const hour = Math.floor(minutes / 60).toString().padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  const expected = Date.parse(`${date}T${hour}:${minute}:00+08:00`);
  return Number.isFinite(timestamp) && Math.abs(timestamp - expected) <= CLOSE_TOLERANCE_SECONDS * 1_000;
}

function isSameShanghaiDate(value: string, expected: string): boolean {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return false;
  return parsed.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) === expected;
}

function shanghaiDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return parsed.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function isTimely(marketTimestamp: string, receivedAt: string): boolean {
  const market = Date.parse(marketTimestamp);
  const received = Date.parse(receivedAt);
  const delta = received - market;
  return Number.isFinite(delta) && delta >= 0 && delta <= CLOSE_TOLERANCE_SECONDS * 1_000;
}

function shanghaiMinutes(value: string): number | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function formatAge(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)} 秒` : "未知时长";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
