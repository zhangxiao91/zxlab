import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupNews,
  instrumentToCode,
  instrumentToTencent,
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
  runWithFallback,
} from "./index.ts";
import { getChinaMarketStatus } from "./calendar.ts";

test("maps normalized instruments for all HTTP providers", () => {
  assert.equal(instrumentToTencent("SSE:512480"), "sh512480");
  assert.deepEqual(instrumentToCode("SZSE:159995"), { exchange: "SZSE", symbol: "159995", prefixed: "sz159995", secid: "0.159995" });
});

test("uses the official 2026 calendar and marks out-of-coverage fallback", () => {
  const holiday = getChinaMarketStatus("SSE", new Date("2026-10-05T02:00:00.000Z"));
  assert.equal(holiday.session, "holiday");
  assert.equal(holiday.open, false);
  assert.equal(holiday.reliable, true);
  assert.equal(holiday.source, "sse-calendar-2026");

  const trading = getChinaMarketStatus("SZSE", new Date("2026-08-03T02:00:00.000Z"));
  assert.equal(trading.session, "open");
  assert.equal(trading.open, true);
  assert.equal(trading.quality, "operational");

  const fallback = getChinaMarketStatus("SSE", new Date("2027-01-04T02:00:00.000Z"));
  assert.equal(fallback.source, "weekday-fallback");
  assert.equal(fallback.reliable, false);
  assert.equal(fallback.quality, "degraded");
  assert.match(fallback.warnings[0], /官方交易日历仅覆盖/);
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
