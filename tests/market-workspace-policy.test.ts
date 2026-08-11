import assert from "node:assert/strict";
import test from "node:test";
import { marketSnapshotFixture } from "../packages/market-schema/src/fixtures.ts";
import {
  emptyMarketWorkspaceState,
  marketBarSeriesKey,
  mergeMarketSnapshots,
  marketRequestCapabilityIds,
  marketRefreshDecision,
  marketSnapshotFailureCapabilities,
  marketSnapshotRequests,
  marketWorkspaceRefreshDecision,
  retainMarketWorkspaceAfterFailure,
} from "../src/features/market/workspace-policy.ts";

test("refresh cadence follows market sessions and actively recovers unknown state", () => {
  const status = (session: "preopen" | "open" | "break" | "closed" | "holiday" | "unknown", reliable = true) => [{
    exchange: "SSE" as const,
    open: session === "open" ? true : session === "unknown" ? null : false,
    session,
    calendarDate: "2026-08-11",
    marketTimestamp: "2026-08-11T01:25:00.000Z",
    asOf: "2026-08-11T01:25:00.000Z",
    receivedAt: "2026-08-11T01:25:00.000Z",
    freshness: reliable ? "fresh" as const : "unknown" as const,
    quality: reliable ? "operational" as const : "degraded" as const,
    reliable,
    source: "fixture",
    warnings: [],
  }];

  assert.equal(marketRefreshDecision(status("preopen"), Date.parse("2026-08-11T01:25:00.000Z")).intervalMs, 5_000);
  assert.equal(marketRefreshDecision(status("open"), Date.parse("2026-08-11T02:00:00.000Z")).intervalMs, 5_000);
  assert.equal(marketRefreshDecision(status("break"), Date.parse("2026-08-11T04:00:00.000Z")).intervalMs, 15_000);
  assert.equal(marketRefreshDecision(status("closed"), Date.parse("2026-08-11T00:00:00.000Z")).intervalMs, 60_000);
  assert.equal(marketRefreshDecision(status("holiday"), Date.parse("2026-08-11T02:00:00.000Z")).intervalMs, 300_000);
  assert.equal(marketRefreshDecision(status("unknown", false), Date.parse("2026-08-11T02:00:00.000Z")).intervalMs, 10_000);
  assert.equal(marketRefreshDecision([], Date.parse("2026-08-11T02:00:00.000Z")).intervalMs, 10_000);
});

test("refresh cadence wakes at the next Shanghai session boundary", () => {
  const fixture = marketSnapshotFixture("live").data.status;
  fixture[0] = { ...fixture[0], session: "preopen", open: false, calendarDate: "2026-08-11" };
  const beforeOpen = marketRefreshDecision(fixture, Date.parse("2026-08-11T01:29:59.000Z"));
  assert.ok(beforeOpen.delayMs >= 1_000 && beforeOpen.delayMs <= 1_500);

  fixture[0] = { ...fixture[0], session: "break", open: false };
  const beforeAfternoon = marketRefreshDecision(fixture, Date.parse("2026-08-11T04:59:59.000Z"));
  assert.ok(beforeAfternoon.delayMs >= 1_000 && beforeAfternoon.delayMs <= 1_500);

  fixture[0] = { ...fixture[0], session: "preopen", open: false };
  const stalePreopen = marketRefreshDecision(fixture, Date.parse("2026-08-11T01:31:00.000Z"));
  assert.equal(stalePreopen.delayMs, 5_000);
  assert.equal(stalePreopen.nextBoundaryAt, null);
});

test("snapshot request planning keeps overview batches bounded and detail scoped", () => {
  const ids = Array.from({ length: 23 }, (_, index) => `SSE:${String(index + 1).padStart(6, "0")}`);
  const requests = marketSnapshotRequests(ids, ids[4], "1m", true);
  const overview = requests.filter((item) => item.include.length === 1 && item.include[0] === "quotes");
  assert.deepEqual(overview.map((item) => item.instrumentIds.length), [10, 10, 3]);
  assert.deepEqual(requests.at(-2), {
    instrumentIds: [ids[4]],
    intervals: ["1m"],
    include: ["bars"],
    quoteMode: "fallback",
  });
  assert.deepEqual(requests.at(-1), {
    instrumentIds: [ids[4]],
    intervals: ["1m"],
    include: ["news", "announcements"],
    quoteMode: "fallback",
  });
  assert.ok(marketRequestCapabilityIds(requests).includes("status:SSE"));
});

test("snapshot quality remains authoritative and transient quote loss retains an explicitly stale last-known-good", () => {
  const currentSnapshot = marketSnapshotFixture("live");
  currentSnapshot.request = { instrumentIds: ["SSE:512480"], intervals: ["1m"], include: ["quotes"], quoteMode: "fallback" };
  currentSnapshot.data.quotes[0].corroboration = { mode: "fallback", status: "not_requested", thresholdBps: 50, maxDeviationBps: null, observations: [] };
  let state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [currentSnapshot]);
  assert.equal(state.quality.freshness, "fresh");
  assert.equal(state.quality.reliable, true);
  assert.equal(state.quality.capabilities[0]?.freshness, "fresh");

  const unavailable = marketSnapshotFixture("unavailable");
  unavailable.request = currentSnapshot.request;
  unavailable.data.quotes[0].corroboration = { mode: "fallback", status: "not_requested", thresholdBps: 50, maxDeviationBps: null, observations: [] };
  state = mergeMarketSnapshots(state, [unavailable]);

  assert.equal(state.quotes[0]?.price, currentSnapshot.data.quotes[0].price);
  assert.equal(state.quotes[0]?.quality, "stale");
  assert.equal(state.quotes[0]?.stale, true);
  assert.equal(state.quality.reliable, false);
  assert.equal(state.quality.freshness, "stale");
  assert.match(state.warnings.join("\n"), /上次成功报价/);
});

test("diagnostic provider failures do not alter authoritative snapshot quality", () => {
  const snapshot = marketSnapshotFixture("live");
  const state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [snapshot], {
    diagnosticWarnings: ["Provider 诊断暂不可用"],
  });
  assert.equal(state.quality.status, "operational");
  assert.equal(state.quality.freshness, "fresh");
  assert.match(state.warnings.join("\n"), /Provider 诊断暂不可用/);
});

test("partial snapshot transport failure is explicit in aggregate quality", () => {
  const snapshot = marketSnapshotFixture("live");
  const state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [snapshot], {
    snapshotWarnings: ["报价批次 SSE:600000 等 10 个标的失败：timeout"],
  });
  assert.equal(state.quality.status, "degraded");
  assert.equal(state.quality.reliable, false);
  assert.equal(state.quality.freshness, "mixed");
  assert.ok(state.quality.unavailableCapabilities.includes("snapshot-request"));
});

test("transport failure capabilities keep slow degradation sticky across fast refreshes", () => {
  const slowRequest = {
    instrumentIds: ["SSE:512480"],
    intervals: ["1m" as const],
    include: ["bars" as const, "news" as const, "announcements" as const],
    quoteMode: "fallback" as const,
  };
  const failedCapabilities = marketSnapshotFailureCapabilities(
    slowRequest,
    "详情 SSE:512480失败：timeout",
    "2026-08-11T02:00:00.000Z",
  );
  const quoteSnapshot = marketSnapshotFixture("live");
  let state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [quoteSnapshot], {
    requestedCapabilityIds: marketRequestCapabilityIds([quoteSnapshot.request, slowRequest]),
    failedCapabilities,
    snapshotWarnings: ["详情 SSE:512480失败：timeout"],
  });
  assert.equal(state.quality.status, "degraded");
  assert.ok(state.quality.unavailableCapabilities.includes("news"));

  state = mergeMarketSnapshots(state, [marketSnapshotFixture("live")]);
  assert.equal(state.quality.status, "degraded");
  assert.equal(state.quality.reliable, false);
  assert.ok(state.quality.capabilities.some((capability) => capability.id === "news" && capability.status === "unavailable"));
  state.status = state.status.map((status) => ({ ...status, open: false, session: "holiday" }));
  assert.equal(marketWorkspaceRefreshDecision(state).intervalMs, 300_000);
});

test("minute and daily bars never share a last-known-good slot", () => {
  const minute = marketSnapshotFixture("live");
  minute.request.include = ["bars"];
  minute.request.intervals = ["1m"];
  minute.data.bars = [{
    instrumentId: "SSE:512480",
    interval: "1m",
    bars: [{
      instrumentId: "SSE:512480",
      timestamp: "2026-08-11T02:00:00.000Z",
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      turnover: 1,
    }],
  }];
  minute.capabilities = [{
    id: "bars:SSE:512480:1m",
    status: "operational",
    required: true,
    asOf: "2026-08-11T02:00:00.000Z",
    receivedAt: "2026-08-11T02:00:00.000Z",
    freshness: "fresh",
    warnings: [],
    attempts: [],
  }];
  let state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [minute]);

  const dailyUnavailable = marketSnapshotFixture("live");
  dailyUnavailable.request.include = ["bars"];
  dailyUnavailable.request.intervals = ["1d"];
  dailyUnavailable.data.bars = [];
  dailyUnavailable.capabilities = [{
    ...minute.capabilities[0],
    id: "bars:SSE:512480:1d",
    status: "unavailable",
    asOf: null,
    freshness: "unknown",
    warnings: ["daily unavailable"],
  }];
  state = mergeMarketSnapshots(state, [dailyUnavailable]);

  assert.equal(state.bars[marketBarSeriesKey("SSE:512480", "1m")]?.length, 1);
  assert.deepEqual(state.bars[marketBarSeriesKey("SSE:512480", "1d")], []);
});

test("partial exchange status keeps the missing exchange only as unknown", () => {
  const initial = marketSnapshotFixture("live");
  initial.request.instrumentIds = ["SSE:512480", "SZSE:000001"];
  initial.data.status.push({ ...initial.data.status[0], exchange: "SZSE" });
  initial.capabilities.push({ ...initial.capabilities[0], id: "status:SSE" }, { ...initial.capabilities[0], id: "status:SZSE" });
  let state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [initial], {
    requestedQuoteIds: initial.request.instrumentIds,
  });

  const partial = marketSnapshotFixture("live");
  partial.request.instrumentIds = initial.request.instrumentIds;
  partial.capabilities.push({ ...partial.capabilities[0], id: "status:SSE" });
  state = mergeMarketSnapshots(state, [partial], {
    requestedQuoteIds: initial.request.instrumentIds,
  });

  const szse = state.status.find((status) => status.exchange === "SZSE");
  assert.equal(szse?.session, "unknown");
  assert.equal(szse?.open, null);
  assert.equal(szse?.reliable, false);
  assert.match(state.warnings.join("\n"), /SZSE 本轮交易状态不可用/);
});

test("duplicate quote batch health is aggregated instead of last-write-wins", () => {
  const live = marketSnapshotFixture("live");
  const unavailable = marketSnapshotFixture("unavailable");
  unavailable.request.instrumentIds = ["SZSE:000001"];
  unavailable.data.quotes[0].instrumentId = "SZSE:000001";
  unavailable.data.status[0].exchange = "SZSE";
  const state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [live, unavailable], {
    requestedQuoteIds: ["SSE:512480", "SZSE:000001"],
  });
  assert.equal(state.quality.capabilities.find((capability) => capability.id === "quotes")?.status, "degraded");
  assert.equal(state.quality.reliable, false);
});

test("provider diagnostic warnings persist until the next successful diagnostic read", () => {
  const snapshot = marketSnapshotFixture("live");
  let state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [snapshot], {
    diagnosticWarnings: ["Provider 诊断暂不可用"],
  });
  state = mergeMarketSnapshots(state, [snapshot]);
  assert.match(state.warnings.join("\n"), /Provider 诊断暂不可用/);
  state = mergeMarketSnapshots(state, [snapshot], { diagnosticWarnings: [] });
  assert.doesNotMatch(state.warnings.join("\n"), /Provider 诊断暂不可用/);
});

test("a new announcement scope clears the previous instrument failure", () => {
  const quote = marketSnapshotFixture("live");
  const requestA = {
    instrumentIds: ["SSE:512480"],
    intervals: ["1m" as const],
    include: ["announcements" as const],
    quoteMode: "fallback" as const,
  };
  let state = mergeMarketSnapshots(emptyMarketWorkspaceState(), [quote], {
    requestedCapabilityIds: marketRequestCapabilityIds([quote.request, requestA]),
    failedCapabilities: marketSnapshotFailureCapabilities(requestA, "A announcements timeout"),
    snapshotWarnings: ["A announcements timeout"],
  });
  assert.ok(state.quality.capabilities.some((capability) => capability.id === "announcements:SSE:512480"));

  const requestB = {
    instrumentIds: ["SZSE:000001"],
    intervals: ["1m" as const],
    include: ["announcements" as const],
    quoteMode: "fallback" as const,
  };
  state = mergeMarketSnapshots(state, [], {
    requestedCapabilityIds: marketRequestCapabilityIds([requestB]),
    failedCapabilities: marketSnapshotFailureCapabilities(requestB, "B announcements timeout"),
    snapshotWarnings: ["B announcements timeout"],
  });
  assert.equal(state.quality.capabilities.some((capability) => capability.id === "announcements:SSE:512480"), false);
  assert.equal(state.quality.capabilities.find((capability) => capability.id === "announcements:SZSE:000001")?.status, "unavailable");

  const detailB = marketSnapshotFixture("live");
  detailB.request = requestB;
  detailB.data.quotes = [];
  detailB.data.announcements = [];
  detailB.data.status[0].exchange = "SZSE";
  detailB.capabilities = [{
    id: "announcements:SZSE:000001",
    status: "operational",
    required: true,
    asOf: detailB.asOf,
    receivedAt: detailB.receivedAt,
    freshness: "fresh",
    warnings: [],
    attempts: [],
  }];
  state = mergeMarketSnapshots(state, [detailB]);
  assert.equal(state.quality.capabilities.some((capability) => capability.id === "announcements:SSE:512480"), false);
  assert.equal(state.quality.capabilities.find((capability) => capability.id === "announcements:SZSE:000001")?.status, "operational");
});

test("an unavailable slow capability retains matching last-known-good content", () => {
  const current = emptyMarketWorkspaceState();
  current.news = [{
    id: "news-1",
    type: "stock-news",
    title: "previous item",
    url: "https://example.com/news-1",
    summary: null,
    content: null,
    source: "fixture",
    publishedAt: "2026-08-11T01:00:00.000Z",
    receivedAt: "2026-08-11T01:00:00.000Z",
    instrumentId: "SSE:512480",
    symbol: "512480",
    warnings: [],
  }];
  const snapshot = marketSnapshotFixture("live");
  snapshot.request.include = ["news"];
  snapshot.data.news = [];
  snapshot.capabilities = [{
    id: "news",
    status: "unavailable",
    required: true,
    asOf: null,
    receivedAt: snapshot.receivedAt,
    freshness: "unknown",
    warnings: ["news unavailable"],
    attempts: [],
  }];

  const next = mergeMarketSnapshots(current, [snapshot]);
  assert.deepEqual(next.news, current.news);
  assert.match(next.warnings.join("\n"), /保留上次成功数据/);
});

test("transport failure keeps the last-known-good but marks it stale and unavailable", () => {
  const snapshot = marketSnapshotFixture("live");
  snapshot.capabilities.push({
    id: "status:SSE",
    status: "operational",
    required: true,
    asOf: snapshot.asOf,
    receivedAt: snapshot.receivedAt,
    freshness: "fresh",
    warnings: [],
    attempts: [],
  });
  const current = mergeMarketSnapshots(emptyMarketWorkspaceState(), [snapshot]);
  const failed = retainMarketWorkspaceAfterFailure(current, "snapshot timeout");
  assert.equal(failed.quotes[0]?.price, snapshot.data.quotes[0].price);
  assert.equal(failed.quotes[0]?.quality, "stale");
  assert.equal(failed.quality.status, "unavailable");
  assert.equal(failed.quality.reliable, false);
  assert.equal(failed.quality.freshness, "stale");
  assert.equal(failed.quality.receivedAt, current.quality.receivedAt);
  assert.equal(failed.status[0]?.session, "unknown");
  assert.equal(failed.status[0]?.open, null);
  assert.equal(failed.quality.capabilities.find((capability) => capability.id === "status:SSE")?.status, "unavailable");
  assert.equal(marketWorkspaceRefreshDecision(failed).intervalMs, 10_000);
  assert.match(failed.warnings.join("\n"), /snapshot timeout/);
});

test("transport failure never erases an existing quote conflict", () => {
  const conflicted = marketSnapshotFixture("conflicted");
  const current = mergeMarketSnapshots(emptyMarketWorkspaceState(), [conflicted]);
  const failed = retainMarketWorkspaceAfterFailure(current, "snapshot timeout");
  assert.equal(failed.quotes[0]?.quality, "conflicted");
  assert.equal(failed.quotes[0]?.stale, true);
  assert.equal(failed.quality.freshness, "stale");
});
