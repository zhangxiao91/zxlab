import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupNews,
  instrumentToCode,
  instrumentToTencent,
  normalizeBarTimestamp,
  parseBaiduDailyBars,
  parseEastmoneyMinuteBars,
  parseEastmoneyAnnouncements,
  parseEastmoneyFastNews,
  parseEastmoneyStockNews,
  parseCninfoAnnouncements,
  parseEastmoneyQuote,
  parseEastmoneySecurityName,
  parseSinaBars,
  parseSinaQuote,
  parseTencentDailyBars,
  parseTencentMinuteBars,
  parseTencentQuote,
  parseTencentStockNews,
  parseTencentSecurityName,
  parseTonghuashunDailyBars,
  loadBars,
  loadQuotes,
  runCorroboratedQuote,
  runWithFallback,
  projectDailyHistoryForResearch,
} from "./index.ts";
import worker from "./index.ts";
import { validateMarketSnapshot } from "../../../packages/market-schema/src/index.ts";
import { CachedTradingCalendar, getChinaMarketStatus, OfficialCnTradingCalendar } from "./calendar.ts";
import { applyIntradayFreshnessDecision, assessIntradayFreshness } from "./freshness.ts";

async function classifyQuote(quote: ReturnType<typeof parseTencentQuote>) {
  const decision = await assessIntradayFreshness({
    exchange: instrumentToCode(quote.instrumentId).exchange,
    marketTimestamp: quote.marketTimestamp,
    receivedAt: quote.receivedAt,
  }, new OfficialCnTradingCalendar());
  return applyIntradayFreshnessDecision(quote, decision);
}

test("maps normalized instruments for all HTTP providers", () => {
  assert.equal(instrumentToTencent("SSE:512480"), "sh512480");
  assert.deepEqual(instrumentToCode("SZSE:159995"), { exchange: "SZSE", symbol: "159995", prefixed: "sz159995", secid: "0.159995" });
});

test("uses the official 2026 calendar and marks out-of-coverage fallback", async () => {
  const holiday = await getChinaMarketStatus("SSE", new Date("2026-10-05T02:00:00.000Z"));
  assert.equal(holiday.session, "holiday");
  assert.equal(holiday.open, false);
  assert.equal(holiday.reliable, true);
  assert.equal(holiday.source, "sse-calendar-2026");

  const trading = await getChinaMarketStatus("SZSE", new Date("2026-08-03T02:00:00.000Z"));
  assert.equal(trading.session, "open");
  assert.equal(trading.open, true);
  assert.equal(trading.quality, "operational");

  const fallback = await getChinaMarketStatus("SSE", new Date("2027-01-04T02:00:00.000Z"));
  assert.equal(fallback.source, "weekday-fallback");
  assert.equal(fallback.reliable, false);
  assert.equal(fallback.quality, "degraded");
  assert.equal(fallback.open, null);
  assert.equal(fallback.session, "unknown");
  assert.match(fallback.warnings[0], /不得用于确定性开闭市判断/);
});

test("calendar adapter supports temporary closures and caches stable dates", async () => {
  let calls = 0;
  const fixture = new OfficialCnTradingCalendar({ start: "2026-08-01", end: "2026-08-31", source: "official-fixture", closures: [{ date: "2026-08-04", kind: "temporary", label: "应急休市演练" }] });
  const cached = new CachedTradingCalendar({ getMarketDay: async (market, date) => { calls += 1; return fixture.getMarketDay(market, date); } });
  const first = await cached.getMarketDay("CN", "2026-08-04");
  const second = await cached.getMarketDay("CN", "2026-08-04");
  assert.equal(first.status, "holiday");
  assert.match(first.warnings[0], /临时休市/);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("serves a validated aggregate snapshot route without recursive HTTP calls", async () => {
  const response = await worker.fetch(new Request("https://market.example/api/market/snapshot?ids=SSE%3A512480&include=comparisons&intervals=1m&quoteMode=fallback"), { ZX_RUNTIME_SERVICE_TOKEN: "test" }, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
  assert.equal(response.status, 200);
  const body = await response.json() as { data: unknown };
  assert.equal(validateMarketSnapshot(body.data).ok, true);
  assert.equal((body.data as { quality: { status: string } }).quality.status, "unavailable");
});

test("parses Tencent quote without coercing empty values to zero", () => {
  const fields = Array(38).fill("");
  fields[3] = "0.899"; fields[4] = "0.906"; fields[5] = "0.904"; fields[6] = "812"; fields[30] = "20260718143205"; fields[33] = "0.910"; fields[34] = "0.892";
  const quote = parseTencentQuote("SSE:512480", `v_sh512480="${fields.join("~")}";`, "2026-07-18T06:32:11.000Z");
  assert.equal(quote.price, .899);
  assert.equal(quote.volume, 81200);
  assert.equal(quote.turnover, null);
  assert.equal(quote.stale, false);
  assert.equal(parseTencentSecurityName('v_sh512480="1~半导体ETF~512480";'), "半导体ETF");
});

test("keeps the latest Friday close current over the weekend", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260807150000"; fields[33] = "11.26"; fields[34] = "11.10";
  const quote = await classifyQuote(parseTencentQuote("SZSE:000001", `v_sz000001="${fields.join("~")}";`, "2026-08-08T07:15:35.000Z"));
  assert.equal(quote.stale, false);
  assert.equal(quote.quality, "live");
  assert.doesNotMatch(quote.warnings.join(" "), /过期/);
});

test("keeps a Friday provider post-close update operational throughout the weekend", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260814161455"; fields[33] = "11.26"; fields[34] = "11.10";
  const receivedAtByWeekendDay = [
    "2026-08-15T07:52:55.693Z",
    "2026-08-16T07:52:55.693Z",
  ];

  const results = await Promise.all(receivedAtByWeekendDay.map((receivedAt) => loadQuotes(["SSE:600000"], "fallback", {
    fetcher: async () => new Response(`v_sh600000="${fields.join("~")}";`),
    now: () => new Date(receivedAt),
    calendar: new OfficialCnTradingCalendar(),
  })));

  assert.deepEqual(
    results.map((result) => [result.data[0]?.quality, result.data[0]?.stale, result.meta.capabilityStatus, result.meta.freshness]),
    [
      ["live", false, "operational", "fresh"],
      ["live", false, "operational", "fresh"],
    ],
  );
});

test("keeps the same-day close current after the market closes", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260807150000"; fields[33] = "11.26"; fields[34] = "11.10";
  const quote = await classifyQuote(parseTencentQuote("SZSE:000001", `v_sz000001="${fields.join("~")}";`, "2026-08-07T12:30:00.000Z"));
  assert.equal(quote.stale, false);
  assert.equal(quote.quality, "live");
});

test("still rejects delayed quotes while the market is open", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260807100000"; fields[33] = "11.26"; fields[34] = "11.10";
  const quote = await classifyQuote(parseTencentQuote("SZSE:000001", `v_sz000001="${fields.join("~")}";`, "2026-08-07T02:05:00.000Z"));
  assert.equal(quote.stale, true);
  assert.equal(quote.quality, "stale");
});

test("does not treat a delayed morning quote as a close during lunch break", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260807110000"; fields[33] = "11.26"; fields[34] = "11.10";
  const quote = await classifyQuote(parseTencentQuote("SZSE:000001", `v_sz000001="${fields.join("~")}";`, "2026-08-07T03:45:00.000Z"));
  assert.equal(quote.stale, true);
  assert.equal(quote.quality, "stale");
});

test("loads quotes with official holiday freshness in both item and capability metadata", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260930150000"; fields[33] = "11.26"; fields[34] = "11.10";
  const result = await loadQuotes(["SSE:600000"], "fallback", {
    fetcher: async () => new Response(`v_sh600000="${fields.join("~")}";`),
    now: () => new Date("2026-10-05T02:00:00.000Z"),
    calendar: new OfficialCnTradingCalendar(),
  });

  assert.equal(result.data[0]?.stale, false);
  assert.equal(result.data[0]?.quality, "live");
  assert.equal(result.meta.capabilityStatus, "operational");
  assert.equal(result.meta.freshness, "fresh");
});

test("loads quote batches with bounded parallelism", async () => {
  const fields = Array(38).fill("");
  fields[3] = "11.19"; fields[4] = "11.27"; fields[5] = "11.23"; fields[6] = "882977"; fields[30] = "20260804100400"; fields[33] = "11.26"; fields[34] = "11.10";
  let started = 0;
  let active = 0;
  let maxActive = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = loadQuotes(["SSE:600000", "SSE:600001", "SSE:600002", "SSE:600003", "SSE:600004", "SSE:600005"], "fallback", {
    fetcher: async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return new Response(`v_quote="${fields.join("~")}";`);
    },
    now: () => new Date("2026-08-04T02:05:00.000Z"),
    calendar: new OfficialCnTradingCalendar(),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedBeforeRelease = started;
  release();
  await pending;

  assert.deepEqual({ startedBeforeRelease, maxActive }, { startedBeforeRelease: 4, maxActive: 4 });
});

test("marks an old morning minute bar stale during the lunch break", async () => {
  const result = await loadBars("SSE:600000", "1m", {
    fetcher: async () => Response.json({ data: { sh600000: { data: { date: "20260804", data: ["1100 11.19 100 1000"] } } } }),
    now: () => new Date("2026-08-04T03:45:00.000Z"),
    calendar: new OfficialCnTradingCalendar(),
  });

  assert.equal(result.meta.capabilityStatus, "degraded");
  assert.equal(result.meta.freshness, "stale");
  assert.match(String((result.meta.warnings as string[])[0]), /11:30/);
});

test("keeps legal minute and daily session closes fresh", async () => {
  const calendar = new OfficialCnTradingCalendar();
  const minute = await loadBars("SSE:600000", "1m", {
    fetcher: async () => Response.json({ data: { sh600000: { data: { date: "20260804", data: ["1130 11.19 100 1000"] } } } }),
    now: () => new Date("2026-08-04T03:45:00.000Z"),
    calendar,
  });
  const daily = await loadBars("SSE:600000", "1d", {
    fetcher: async () => Response.json({ data: { sh600000: { day: [["2026-09-30", "11", "11.19", "11.26", "11.10", "100"]] } } }),
    now: () => new Date("2026-10-05T02:00:00.000Z"),
    calendar,
  });

  assert.deepEqual(
    [minute.meta.capabilityStatus, minute.meta.freshness, daily.meta.capabilityStatus, daily.meta.freshness],
    ["operational", "fresh", "operational", "fresh"],
  );
});

test("normalizes Sina and Eastmoney backup quotes", () => {
  const fields = Array(33).fill("");
  fields[1] = "0.904"; fields[2] = "0.906"; fields[3] = "0.899"; fields[4] = "0.910"; fields[5] = "0.892"; fields[8] = "812"; fields[9] = "730"; fields[30] = "2026-07-18"; fields[31] = "14:32:05";
  const sina = parseSinaQuote("SSE:512480", `var hq_str_sh512480="${fields.join(",")}";`, "2026-07-18T06:32:11.000Z");
  const eastmoney = parseEastmoneyQuote("SSE:512480", { data: { f43: 899, f44: 910, f45: 892, f46: 904, f47: 812, f48: 730, f59: 3, f60: 906, f86: 1784356325 } }, "2026-07-18T06:32:11.000Z");
  assert.equal(sina.price, .899);
  assert.equal(eastmoney.price, .899);
  assert.equal(eastmoney.previousClose, .906);
  assert.equal(eastmoney.volume, 81200);
  assert.equal(parseEastmoneySecurityName({ data: { f58: "浦发银行" } }), "浦发银行");
});

test("normalizes three daily and minute K schemas", () => {
  assert.equal(parseTencentDailyBars("SSE:512480", "sh512480", { data: { sh512480: { day: [["2026-07-18", "1", "2", "3", "0.5", "10"]] } } })[0].close, 2);
  assert.equal(parseBaiduDailyBars("SSE:512480", { Result: { newMarketData: { keys: ["time", "open", "close", "high", "low", "volume", "amount"], marketData: "20260718,1,2,3,0.5,10,20" } } })[0].turnover, 20);
  assert.equal(parseSinaBars("SSE:512480", [{ day: "2026-07-18", open: "1", close: "2", high: "3", low: ".5", volume: "10" }], "sina-kline")[0].source, "sina-kline");
  assert.equal(parseTonghuashunDailyBars("SSE:512480", 'callback({"data":"20260718,1,3,0.5,2,10,20"})')[0].close, 2);
  assert.equal(parseTencentMinuteBars("SSE:512480", "sh512480", { data: { sh512480: { data: { date: "20260718", data: ["0930 0.899 10 9"] } } } })[0].open, null);
  assert.equal(parseEastmoneyMinuteBars("SSE:512480", { data: { trends: ["2026-07-18 09:30,0.898,0.899,0.900,0.897,10,9"] } })[0].close, .899);
});

test("normalizes provider bar timestamps to timezone-aware ISO values", () => {
  assert.equal(normalizeBarTimestamp("20260803 0930"), "2026-08-03T01:30:00.000Z");
  assert.equal(normalizeBarTimestamp("2026-08-03 09:30"), "2026-08-03T01:30:00.000Z");
  assert.equal(normalizeBarTimestamp("2026-08-03"), "2026-08-02T16:00:00.000Z");
  assert.equal(normalizeBarTimestamp("not-a-date"), null);
});

test("falls back sequentially and preserves attempt diagnostics", async () => {
  const result = await runWithFallback("quote", [
    { name: "primary", load: async () => { throw new Error("primary unavailable"); } },
    { name: "backup-1", load: async () => "ok" },
    { name: "backup-2", load: async () => "unused" },
  ], async () => new Response());
  assert.equal(result.data, "ok");
  assert.equal(result.source, "backup-1");
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.attempts.map((item) => [item.provider, item.ok]), [["primary", false], ["backup-1", true]]);
});

test("schema failure takes precedence over pure and mixed provider exhaustion", async () => {
  const cases = [
    [
      { name: "schema-a", load: async () => parseTonghuashunDailyBars("SSE:600000", "invalid") },
      { name: "schema-b", load: async () => parseTonghuashunDailyBars("SSE:600000", "still invalid") },
    ],
    [
      { name: "schema", load: async () => parseTonghuashunDailyBars("SSE:600000", "invalid") },
      { name: "transport", load: async () => { throw new Error("network unavailable"); } },
    ],
  ];
  for (const providers of cases) {
    await assert.rejects(
      runWithFallback("daily-bars", providers),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "UPSTREAM_SCHEMA_CHANGED"),
    );
  }
});

test("research daily-history projection rejects missing required close or volume", () => {
  for (const invalid of [{ close: null, volume: 100 }, { close: 10, volume: null }]) {
    const loaded = {
      data: [{ instrumentId: "SSE:600000", timestamp: "2026-08-14T07:00:00.000Z", open: 10, high: 11, low: 9, ...invalid, turnover: 1000, source: "fixture" }],
      meta: { source: "fixture", receivedAt: "2026-08-14T07:00:01.000Z", warnings: [] },
    };
    assert.throws(
      () => projectDailyHistoryForResearch("SSE:600000", loaded),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "UPSTREAM_SCHEMA_CHANGED"),
    );
  }
});

test("corroborated quotes become conflicted only when independent sources exceed the threshold", async () => {
  const quote = (price: number) => ({ instrumentId: "SSE:512480", price, previousClose: .9, open: .9, high: price, low: .9, volume: 1, turnover: 1, marketTimestamp: "2026-08-03T02:00:00.000Z", receivedAt: "2026-08-03T02:00:01.000Z", source: "fixture", quality: "live" as const, stale: false, warnings: [], fallbackUsed: false, providerAttempts: [] });
  const result = await runCorroboratedQuote([
    { name: "primary", load: async () => quote(1) },
    { name: "secondary", load: async () => quote(1.02) },
  ], async () => new Response(), 50);
  assert.equal(result.quality, "conflicted");
  assert.equal(result.corroboration?.status, "conflicted");
  assert.equal(result.corroboration?.observations.length, 2);
  assert.ok((result.corroboration?.maxDeviationBps ?? 0) > 50);
});

test("corroborated mode reports a limitation when only one source succeeds", async () => {
  const quote = { instrumentId: "SSE:512480", price: 1, previousClose: .9, open: .9, high: 1, low: .9, volume: 1, turnover: 1, marketTimestamp: "2026-08-03T02:00:00.000Z", receivedAt: "2026-08-03T02:00:01.000Z", source: "fixture", quality: "live" as const, stale: false, warnings: [], fallbackUsed: false, providerAttempts: [] };
  const result = await runCorroboratedQuote([
    { name: "primary", load: async () => quote },
    { name: "secondary", load: async () => { throw new Error("offline"); } },
  ], async () => new Response(), 50);
  assert.equal(result.quality, "live");
  assert.equal(result.corroboration?.status, "limited");
  assert.equal(result.corroboration?.maxDeviationBps, null);
  assert.doesNotMatch(result.warnings.join(" "), /超过 .* 阈值/);
});

test("normalizes Eastmoney stock news and 7x24 market news", () => {
  const stock = parseEastmoneyStockNews("SSE:600000", { data: { list: [] }, result: { cmsArticleWebOld: [{ code: "art-1", title: "<em>浦发银行发</em>布业绩快报", url: "https://finance.eastmoney.com/a/1.html", content: "<p>净利润增长</p>", date: "2026-07-18 14:20:00" }, { info_code: "202607183459000001", title: "浦发银行经营更新", publish_time: "2026-07-18 14:18:00" }] } });
  assert.equal(stock[0].id, "eastmoney-stock:art-1");
  assert.equal(stock[0].instrumentId, "SSE:600000");
  assert.equal(stock[0].title, "浦发银行发布业绩快报");
  assert.equal(stock[0].summary, "净利润增长");
  assert.equal(stock[1].url, "https://finance.eastmoney.com/a/202607183459000001.html");
  assert.equal(stock[1].publishedAt, "2026-07-18T06:18:00.000Z");

  const fast = parseEastmoneyFastNews({ data: { fastNewsList: [{ code: "f1", title: "市场午后回暖", digest: "ETF 成交放大", showTime: "2026-07-18 14:21:00" }, { code: "f2", title: "市场成交更新", showTime: "2026-07-18 14:19:00" }] } });
  assert.equal(fast[0].type, "market-news");
  assert.equal(fast[0].source, "eastmoney-724");
  assert.deepEqual(dedupNews([...fast, ...stock], 4).map((item) => item.type), ["market-news", "stock-news", "market-news", "stock-news"]);
});

test("normalizes Tencent stock news", () => {
  const items = parseTencentStockNews("SSE:600000", { data: { data: [{ id: "nes-1", title: "浦发银行经营动态", url: "https://gu.qq.com/news/nes-1", time: "2026-07-25 09:58:53", src: "证券时报", summary: "" }] } });
  assert.equal(items[0].id, "tencent-stock:nes-1");
  assert.equal(items[0].type, "stock-news");
  assert.equal(items[0].source, "tencent-stock-news");
  assert.equal(items[0].instrumentId, "SSE:600000");
  assert.equal(items[0].summary, "来源：证券时报");
  assert.equal(items[0].publishedAt, "2026-07-25T01:58:53.000Z");
});

test("normalizes Cninfo announcements", () => {
  const items = parseCninfoAnnouncements("SZSE:159995", { announcements: [{ announcementId: "120", announcementTitle: "芯片 ETF 公告", adjunctUrl: "finalpage/2026-07-18/120.PDF", announcementTime: 1784355600000 }] });
  assert.equal(items[0].id, "cninfo:120");
  assert.equal(items[0].type, "announcement");
  assert.equal(items[0].url, "https://static.cninfo.com.cn/finalpage/2026-07-18/120.PDF");
  assert.equal(items[0].symbol, "159995");
});

test("normalizes Eastmoney announcement fallback", () => {
  const items = parseEastmoneyAnnouncements("SSE:600000", { data: { list: [{ art_code: "AN202607241827324178", title: "浦发银行公告", display_time: "2026-07-24 19:16:45", columns: [{ column_name: "借贷" }] }] } });
  assert.equal(items[0].id, "eastmoney-announcement:AN202607241827324178");
  assert.equal(items[0].source, "eastmoney-announcement");
  assert.equal(items[0].summary, "借贷");
  assert.equal(items[0].url, "https://data.eastmoney.com/notices/detail/600000/AN202607241827324178.html");
  assert.deepEqual(parseEastmoneyAnnouncements("SSE:512480", { data: { list: [] } }), []);
});
