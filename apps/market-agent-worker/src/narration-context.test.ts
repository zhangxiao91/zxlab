import assert from "node:assert/strict";
import test from "node:test";
import type { AskScope, EvidenceItem, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { buildNarrationContext } from "./narration-context.ts";

function evidence(items: EvidenceItem[], scope: AskScope = "today_change"): SealedEvidenceBundle {
  return {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "profile-1",
    workflow: "ask",
    watchlistRevision: "watchlist-1",
    instrumentIds: ["SSE:600000"],
    items,
    contextUses: [],
    fingerprint: "sha256:context",
    sealedAt: "2026-08-07T08:00:01.000Z",
    ask: { scope, planVersion: "ask-plan.v1" },
  };
}

function snapshotContext(session: string, freshness = "fresh", reliable = true, capabilities: unknown[] = [], reference?: unknown): EvidenceItem {
  return {
    id: "snapshot-context",
    kind: "market_fact",
    origin: "server-observed",
    reliable,
    value: {
      type: "snapshot_context",
      asOf: "2026-08-07T08:00:00.000Z",
      receivedAt: "2026-08-07T08:00:01.000Z",
      marketTimestamp: "2026-08-07T08:00:00.000Z",
      quality: { status: reliable ? "operational" : "degraded", reliable, freshness, warnings: reliable ? [] : ["stale quotes"], unavailableCapabilities: [] },
      markets: [{ exchange: "SSE", session, open: session === "open", calendarDate: "2026-08-07", reliable: session !== "unknown", freshness }],
      capabilities,
      ...(reference ? { reference } : {}),
    },
  };
}

test("claim policy changes deterministically across market sessions and freshness states", () => {
  const cases = [
    { session: "open", freshness: "fresh", reliable: true, expected: "live-if-fresh" },
    { session: "preopen", freshness: "fresh", reliable: true, expected: "last-observed-not-live" },
    { session: "break", freshness: "fresh", reliable: true, expected: "last-observed-not-live" },
    { session: "closed", freshness: "fresh", reliable: true, expected: "last-observed-not-live" },
    { session: "holiday", freshness: "fresh", reliable: true, expected: "last-observed-not-live" },
    { session: "unknown", freshness: "unknown", reliable: false, expected: "current-price-claims-forbidden" },
    { session: "open", freshness: "stale", reliable: false, expected: "current-price-claims-forbidden" },
  ] as const;

  for (const fixture of cases) {
    const context = buildNarrationContext({ evidence: evidence([snapshotContext(fixture.session, fixture.freshness, fixture.reliable)]), workflow: "ask", askScope: "today_change" });
    assert.equal(context.marketState.claimPolicy, fixture.expected, `${fixture.session}/${fixture.freshness}`);
  }
});

test("today-change context treats a fresh Sunday snapshot as Friday's effective session, not stale data", () => {
  const reference = { requestedCalendarDate: "2026-08-16", effectiveTradingDate: "2026-08-14", session: "holiday", semantics: "last_effective_session" };
  const context = buildNarrationContext({
    evidence: evidence([snapshotContext("holiday", "fresh", true, [], reference)]),
    workflow: "ask",
    askScope: "today_change",
  });

  assert.deepEqual(context.marketState.reference, reference);
  assert.equal(context.marketState.claimPolicy, "last-observed-not-live");
  assert.match(context.marketState.guidance.join(" "), /effective trading date/i);
  assert.match(context.marketState.guidance.join(" "), /not stale/i);
});

test("data-quality scope retains capability failures and limitations ahead of a large quote set", () => {
  const quotes: EvidenceItem[] = Array.from({ length: 120 }, (_, index) => ({
    id: `quote-${index}`,
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: { type: "quote", instrumentId: `SSE:${String(600000 + index).padStart(6, "0")}`, price: 10 + index, previousClose: 10, quality: "live", stale: false },
  }));
  const items = [
    ...quotes,
    snapshotContext("open", "mixed", true, [
      { id: "quotes", status: "operational", required: true, freshness: "fresh", warnings: [] },
      { id: "bars:SSE:600000:1m", status: "unavailable", required: true, freshness: "unknown", warnings: ["provider exhausted"] },
    ]),
    { id: "bars-limitation", kind: "limitation", origin: "server-observed", reliable: true, value: { capability: "bars:SSE:600000:1m", status: "unavailable", warnings: ["provider exhausted"] } },
  ] satisfies EvidenceItem[];

  const context = buildNarrationContext({ evidence: evidence(items, "data_quality"), workflow: "ask", askScope: "data_quality" });

  assert.ok(context.evidence.some((item) => item.id === "snapshot-context"));
  assert.ok(context.evidence.some((item) => item.id === "bars-limitation"));
  assert.equal(context.marketState.capabilityIssues.length, 1);
  assert.equal(context.marketState.claimPolicy, "last-observed-not-live");
  assert.equal(context.selection.includedItems, 32);
  assert.equal(context.selection.omittedItems, 90);
});

test("relative-performance context prioritizes the selected quote without exposing unsealed derived ranks", () => {
  const items: EvidenceItem[] = [
    snapshotContext("open"),
    { id: "plan", kind: "execution_plan", origin: "server-observed", reliable: true, value: { type: "ask_plan", scope: "relative_performance", selectedInstrumentId: "SSE:600001" } },
    { id: "quote-selected", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600001", price: 9, previousClose: 10, quality: "live", stale: false } },
    { id: "quote-leader", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600002", price: 12, previousClose: 10, quality: "live", stale: false } },
    { id: "quote-middle", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600003", price: 10.5, previousClose: 10, quality: "live", stale: false } },
  ];

  const context = buildNarrationContext({ evidence: evidence(items, "relative_performance"), workflow: "ask", askScope: "relative_performance" });
  assert.equal(context.focus.selectedInstrumentId, "SSE:600001");
  assert.equal("derived" in context, false);
  assert.ok(context.evidence.findIndex((item) => item.id === "quote-selected") < context.evidence.findIndex((item) => item.id === "quote-middle"));
});

test("relative-performance context retains deterministic Research Facts with formula provenance", () => {
  const quotes: EvidenceItem[] = Array.from({ length: 40 }, (_, index) => ({
    id: `quote-${index}`,
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: { type: "quote", instrumentId: `SSE:${String(600000 + index).padStart(6, "0")}`, price: 10 + index, previousClose: 10, quality: "live", stale: false },
  }));
  const research: EvidenceItem = {
    id: "research-baseline",
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: {
      type: "research_fact",
      researchFingerprint: "sha256:research",
      planVersion: "relative-performance.v1",
      purpose: "relative_performance",
      fact: {
        id: "baseline:SSE:600000:price_return:20",
        kind: "market_baseline",
        subjectId: "SSE:600000",
        baselineType: "price_return",
        window: 20,
        value: { decimal: "0.1234", unit: "ratio" },
        formula: { id: "price.total_return", version: "1", inputArtifactIds: ["bars:fixture"] },
      },
    },
  };

  const context = buildNarrationContext({ evidence: evidence([...quotes, research], "relative_performance"), workflow: "ask", askScope: "relative_performance" });
  const projected = context.evidence.find((item) => item.id === research.id);

  assert.ok(projected);
  assert.equal(((projected.value.fact as { formula?: { version?: string } }).formula?.version), "1");
});

test("news-and-announcements context retains financial Research Facts beside external reports", () => {
  const announcements: EvidenceItem[] = Array.from({ length: 40 }, (_, index) => ({
    id: `announcement-${index}`,
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: { evidenceType: "announcement", instrumentId: "SSE:600000", title: `公告 ${index}`, publishedAt: "2026-08-15T07:00:00.000Z" },
  }));
  const research: EvidenceItem = {
    id: "research-financial",
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: {
      type: "research_fact",
      researchFingerprint: "sha256:financial",
      planVersion: "company-update.v1",
      purpose: "company_update",
      fact: {
        id: "financial:SSE:600000:operating_revenue:2026Q2",
        kind: "financial_metric",
        subjectId: "SSE:600000",
        metric: "operating_revenue",
        period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
        value: { decimal: "2500000000", unit: "CNY" },
        comparisons: [{ kind: "yoy", decimal: "0.12", unit: "ratio" }],
      },
    },
  };

  const context = buildNarrationContext({ evidence: evidence([...announcements, research], "news_and_announcements"), workflow: "ask", askScope: "news_and_announcements" });
  const projected = context.evidence.find((item) => item.id === research.id);

  assert.ok(projected);
  assert.equal(context.focus.strategy, "announcements-financials-and-material-context-first");
  assert.equal((((projected.value.fact as { comparisons?: unknown[] }).comparisons)?.length), 1);
});

test("close review keeps the point-in-time Snapshot diff ahead of a large quote set", () => {
  const quotes: EvidenceItem[] = Array.from({ length: 120 }, (_, index) => ({
    id: `quote-${index}`,
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: { type: "quote", instrumentId: `SSE:${String(600000 + index).padStart(6, "0")}`, price: 10 + index, previousClose: 10, quality: "live", stale: false },
  }));
  const diff: EvidenceItem = {
    id: "snapshot-diff",
    kind: "snapshot_diff",
    origin: "server-observed",
    reliable: true,
    value: { previousAsOf: "2026-08-06T08:00:00.000Z", currentAsOf: "2026-08-07T08:00:00.000Z", changes: [{ kind: "quote_price", instrumentId: "SSE:600000", previous: 10, current: 11, delta: 1, deltaBps: 1000 }] },
  };

  const context = buildNarrationContext({ evidence: evidence([...quotes, diff]), workflow: "close_review" });

  assert.ok(context.evidence.some((item) => item.id === "snapshot-diff"));
});
