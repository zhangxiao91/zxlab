import assert from "node:assert/strict";
import test from "node:test";
import { OfficialCnTradingCalendar } from "./calendar.ts";
import { assessDailyBarFreshness, assessIntradayFreshness } from "./freshness.ts";

test("accepts the latest official close across a multi-day holiday", async () => {
  const decision = await assessIntradayFreshness({
    exchange: "SSE",
    marketTimestamp: "2026-09-30T07:00:00.000Z",
    receivedAt: "2026-10-05T02:00:00.000Z",
  }, new OfficialCnTradingCalendar());

  assert.equal(decision.session, "holiday");
  assert.equal(decision.freshness, "fresh");
  assert.equal(decision.stale, false);
  assert.equal(decision.expectedCloseDate, "2026-09-30");
});

test("accepts the previous trading close during preopen", async () => {
  const decision = await assessIntradayFreshness({
    exchange: "SZSE",
    marketTimestamp: "2026-08-03T07:00:00.000Z",
    receivedAt: "2026-08-04T01:20:00.000Z",
  }, new OfficialCnTradingCalendar());

  assert.equal(decision.session, "preopen");
  assert.equal(decision.freshness, "fresh");
  assert.equal(decision.stale, false);
  assert.equal(decision.expectedCloseDate, "2026-08-03");
});

test("classifies intraday timestamps against the active trading session", async () => {
  const calendar = new OfficialCnTradingCalendar();
  const cases = [
    ["2026-08-04T01:19:00.000Z", "2026-08-04T01:20:00.000Z", "preopen", "fresh"],
    ["2026-08-04T02:04:00.000Z", "2026-08-04T02:05:00.000Z", "open", "fresh"],
    ["2026-08-04T02:00:00.000Z", "2026-08-04T02:05:00.000Z", "open", "stale"],
    ["2026-08-04T03:30:00.000Z", "2026-08-04T03:45:00.000Z", "break", "fresh"],
    ["2026-08-04T03:00:00.000Z", "2026-08-04T03:45:00.000Z", "break", "stale"],
    ["2026-08-04T03:30:00.000Z", "2026-08-04T05:05:00.000Z", "open", "stale"],
    ["2026-08-04T05:04:00.000Z", "2026-08-04T05:05:00.000Z", "open", "fresh"],
    ["2026-08-04T07:00:00.000Z", "2026-08-04T08:30:00.000Z", "closed", "fresh"],
    ["2026-08-03T07:00:00.000Z", "2026-08-04T00:00:00.000Z", "closed", "fresh"],
  ] as const;

  const observed = await Promise.all(cases.map(async ([marketTimestamp, receivedAt]) => {
    const decision = await assessIntradayFreshness({ exchange: "SSE", marketTimestamp, receivedAt }, calendar);
    return [decision.session, decision.freshness];
  }));

  assert.deepEqual(observed, cases.map(([, , session, freshness]) => [session, freshness]));
});

test("classifies daily bars by the latest completed official trading day", async () => {
  const calendar = new OfficialCnTradingCalendar();
  const cases = [
    ["2026-08-02T16:00:00.000Z", "2026-08-04T02:00:00.000Z", "fresh"],
    ["2026-08-03T16:00:00.000Z", "2026-08-04T02:00:00.000Z", "fresh"],
    ["2026-08-03T16:00:00.000Z", "2026-08-04T08:30:00.000Z", "fresh"],
    ["2026-08-02T16:00:00.000Z", "2026-08-04T08:30:00.000Z", "stale"],
    ["2026-09-29T16:00:00.000Z", "2026-10-05T02:00:00.000Z", "fresh"],
  ] as const;

  const observed = await Promise.all(cases.map(async ([marketTimestamp, receivedAt]) => {
    const decision = await assessDailyBarFreshness({ exchange: "SSE", marketTimestamp, receivedAt }, calendar);
    return decision.freshness;
  }));

  assert.deepEqual(observed, cases.map(([, , freshness]) => freshness));
});

test("honors temporary closures and surfaces unknown calendar coverage", async () => {
  const temporaryClosure = new OfficialCnTradingCalendar({
    start: "2026-08-01",
    end: "2026-08-31",
    source: "official-fixture",
    closures: [{ date: "2026-08-04", kind: "temporary", label: "应急休市演练" }],
  });
  const closed = await assessIntradayFreshness({
    exchange: "SSE",
    marketTimestamp: "2026-08-03T07:00:00.000Z",
    receivedAt: "2026-08-04T02:00:00.000Z",
  }, temporaryClosure);
  const unknown = await assessIntradayFreshness({
    exchange: "SSE",
    marketTimestamp: "2026-12-31T07:00:00.000Z",
    receivedAt: "2027-01-04T02:00:00.000Z",
  }, new OfficialCnTradingCalendar());

  assert.deepEqual(
    [closed.session, closed.freshness, closed.expectedCloseDate, unknown.session, unknown.freshness, unknown.stale],
    ["holiday", "fresh", "2026-08-03", "unknown", "unknown", true],
  );
  assert.match(closed.warnings.join(" "), /临时休市/);
});
