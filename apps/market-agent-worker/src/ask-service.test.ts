import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, MarketAgentAskCommand } from "@zxlab/market-agent-schema";
import type { MarketSnapshot, MarketSnapshotRequest } from "@zxlab/market-schema";
import { calculateResearchFactBundleFingerprint, parseResearchFactBundle, type ResearchFactBundle } from "@zxlab/research-fact-schema";
import { researchFactBundleFixture } from "@zxlab/research-fact-schema/fixtures";
import { AskService } from "./ask-service.ts";
import { createRunCheckpoint } from "./run-checkpoint.ts";

function ask(overrides: Partial<MarketAgentAskCommand> = {}): MarketAgentAskCommand {
  return {
    workflow: "ask",
    scope: "today_change",
    profileId: "profile-1",
    trigger: "manual",
    idempotencyKey: "ask-service-1",
    resolvedInstrumentIds: ["SSE:600000"],
    ...overrides,
  };
}

function marketSnapshot(request: MarketSnapshotRequest): MarketSnapshot {
  return {
    schemaVersion: "market-snapshot.v1",
    asOf: "2026-08-07T08:00:00.000Z",
    receivedAt: "2026-08-07T08:00:01.000Z",
    marketTimestamp: "2026-08-07T08:00:00.000Z",
    request,
    data: {
      quotes: [{
        instrumentId: "SSE:600000",
        price: 12,
        previousClose: 10,
        open: 10,
        high: 12,
        low: 10,
        volume: 100,
        turnover: 1200,
        marketTimestamp: "2026-08-07T08:00:00.000Z",
        receivedAt: "2026-08-07T08:00:01.000Z",
        source: "fixture",
        quality: "live",
        stale: false,
        warnings: [],
        corroboration: { mode: request.quoteMode, status: request.quoteMode === "corroborated" ? "corroborated" : "not_requested", thresholdBps: 50, maxDeviationBps: 10, observations: [] },
      }],
      bars: [],
      news: [],
      announcements: [],
      status: [],
    },
    capabilities: [],
    quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] },
  };
}

function weekendSnapshot(request: MarketSnapshotRequest, asOf: string): MarketSnapshot {
  const current = marketSnapshot(request);
  return {
    ...current,
    asOf,
    receivedAt: asOf,
    marketTimestamp: "2026-08-14T07:00:00.000Z",
    reference: {
      requestedCalendarDate: "2026-08-16",
      effectiveTradingDate: "2026-08-14",
      session: "holiday",
      semantics: "last_effective_session",
    },
    quality: { ...current.quality, status: "operational", reliable: true, freshness: "fresh" },
  };
}

async function laggedPriceContextResearch() {
  const research = researchFactBundleFixture();
  research.purpose = "price_context";
  research.planVersion = "price-context.v1";
  research.expectedLatestSessionDate = "2026-08-14";
  const baseline = research.capabilities.find((capability) => capability.id === "market_baselines")!;
  baseline.status = "degraded";
  baseline.asOf = "2026-08-13T07:00:00.000Z";
  baseline.warnings = ["LATEST_SESSION_MISSING"];
  baseline.limitations = [{
    code: "LATEST_SESSION_MISSING",
    retryable: false,
    expectedSessionDate: "2026-08-14",
    actualSessionDate: "2026-08-13",
  }];
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  return research;
}

async function companyUpdateResearch(observationCutoff = "2026-08-07T08:00:00.000Z"): Promise<ResearchFactBundle> {
  const research: ResearchFactBundle = {
    schemaVersion: "research-facts.v2",
    planVersion: "company-update.v1",
    purpose: "company_update",
    observationCutoff,
    knowledgeCutoff: observationCutoff,
    generatedAt: observationCutoff,
    instrumentIds: ["SSE:600000"],
    facts: [{
      id: "financial:SSE:600000:operating_revenue:2026Q2",
      kind: "financial_metric",
      subjectId: "SSE:600000",
      metric: "operating_revenue",
      period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
      value: { decimal: "2500000000", unit: "CNY" },
      formula: { id: "financial.single_quarter.v1", version: "1", expression: "current_cumulative - previous_cumulative", inputArtifactIds: ["filing:h1", "filing:q1"], parameters: { period: "Q2" }, rounding: "exact-decimal" },
      comparisons: [{ kind: "yoy", comparablePeriod: { start: "2025-04-01T00:00:00.000Z", end: "2025-06-30T00:00:00.000Z", basis: "quarter" }, decimal: "0.12", unit: "ratio", formula: { id: "financial.yoy.v1", version: "1", expression: "current / prior - 1", inputArtifactIds: ["filing:h1", "filing:q1", "filing:h1-prior", "filing:q1-prior"], parameters: {}, rounding: "decimal-12-nearest" } }],
      provenance: { providers: ["eastmoney", "cninfo"], sourceArtifactIds: ["filing:h1", "filing:q1", "filing:h1-prior", "filing:q1-prior"], sourceAsOf: "2026-07-31T10:00:00.000Z", retrievedAt: "2026-08-07T08:00:00.000Z" },
      quality: { status: "operational", reliable: true, coverage: { actual: 4, required: 4 }, warnings: [] },
    }],
    capabilities: [{ id: "fundamentals", required: true, status: "operational", factIds: ["financial:SSE:600000:operating_revenue:2026Q2"], asOf: "2026-07-31T10:00:00.000Z", retrievedAt: "2026-08-07T08:00:00.000Z", warnings: [], limitations: [] }],
    fingerprint: "sha256:pending",
  };
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  return parseResearchFactBundle(research);
}

test("Ask executes only the static plan and seals that plan into evidence", async () => {
  let request: MarketSnapshotRequest | undefined;
  const service = new AskService({
    getCurrentSnapshot: async (input) => {
      request = input;
      return marketSnapshot(input);
    },
  });

  const output = await service.execute({
    runId: "ask-run-1",
    command: ask(),
    watchlistRevision: "watchlist-1",
  });

  assert.deepEqual(request, {
    instrumentIds: ["SSE:600000"],
    intervals: ["1d", "1m"],
    include: ["quotes", "bars"],
    quoteMode: "corroborated",
  });
  assert.equal(output.evidence.ask?.scope, "today_change");
  assert.equal(output.evidence.items.some((item) => item.kind === "execution_plan"), true);
  assert.equal(output.result.askScope, "today_change");
  assert.equal(output.result.observations[0]?.class, "fact");
});

test("weekend Ask propagates the effective session to Research and limits only lagged Research evidence", async () => {
  const research = await laggedPriceContextResearch();
  const asOf = research.observationCutoff;
  let researchRequest: Parameters<NonNullable<ConstructorParameters<typeof AskService>[3]>["materialize"]>[0] | undefined;
  const service = new AskService(
    { getCurrentSnapshot: async (input) => weekendSnapshot(input, asOf) },
    undefined,
    undefined,
    { async materialize(input) { researchRequest = input; return research; } },
  );

  const output = await service.execute({
    runId: "ask-weekend-research-lag",
    command: ask({ instrumentId: "SSE:600000" }),
    watchlistRevision: "watchlist-1",
  });

  assert.deepEqual(researchRequest, {
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    selectedInstrumentId: "SSE:600000",
    observationCutoff: asOf,
    expectedLatestSessionDate: "2026-08-14",
  });
  assert.equal(output.result.status, "partial");
  assert.equal(output.result.outcome?.evidence.coverage, "limited");
  const limitation = output.result.outcome?.evidence.limitations.find((item) => item.code === "LATEST_SESSION_MISSING");
  assert.equal(limitation?.capability, "research:market_baselines");
  assert.match(limitation?.message ?? "", /expected=2026-08-14/);
  assert.match(limitation?.message ?? "", /actual=2026-08-13/);
  assert.equal(output.result.outcome?.evidence.limitations.some((item) => item.code === "MARKET_SNAPSHOT_UNRELIABLE"), false);
  const snapshotContext = output.evidence.items.find((item) => (item.value as { type?: unknown })?.type === "snapshot_context");
  assert.deepEqual((snapshotContext?.value as { quality?: unknown }).quality, {
    status: "operational",
    reliable: true,
    freshness: "fresh",
    warnings: [],
    unavailableCapabilities: [],
  });
});

test("weekend Ask rejects a Research bundle sealed for another expected latest session", async () => {
  const research = await laggedPriceContextResearch();
  research.expectedLatestSessionDate = "2026-08-13";
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  const service = new AskService(
    { getCurrentSnapshot: async (input) => weekendSnapshot(input, research.observationCutoff) },
    undefined,
    undefined,
    { async materialize() { return research; } },
  );

  await assert.rejects(service.execute({
    runId: "ask-weekend-research-scope-mismatch",
    command: ask({ instrumentId: "SSE:600000" }),
    watchlistRevision: "watchlist-1",
  }), /RESEARCH_FACT_SCOPE_MISMATCH/);
});

test("Ask does not impose a completed-session baseline date during a live session", async () => {
  const research = researchFactBundleFixture();
  research.purpose = "price_context";
  research.planVersion = "price-context.v1";
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  let researchRequest: Parameters<NonNullable<ConstructorParameters<typeof AskService>[3]>["materialize"]>[0] | undefined;
  const service = new AskService(
    { getCurrentSnapshot: async (input) => ({
      ...marketSnapshot(input),
      asOf: research.observationCutoff,
      reference: { requestedCalendarDate: "2026-08-14", effectiveTradingDate: "2026-08-14", session: "open", semantics: "live_session" },
    }) },
    undefined,
    undefined,
    { async materialize(input) { researchRequest = input; return research; } },
  );

  await service.execute({ runId: "ask-live-research", command: ask({ instrumentId: "SSE:600000" }), watchlistRevision: "watchlist-1" });

  assert.equal(Object.hasOwn(researchRequest ?? {}, "expectedLatestSessionDate"), false);
});

test("Ask includes a bounded historical run only when the persisted scope matches it", async () => {
  const previousResult: AgentResult = {
    status: "success",
    headline: "Earlier review",
    summary: "earlier",
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: "sha256:previous",
    mode: "market-only",
  };
  const service = new AskService({ getCurrentSnapshot: async (input) => marketSnapshot(input) });
  const output = await service.execute({
    runId: "ask-run-previous",
    command: ask({
      scope: "compare_previous_run",
      priorRunId: "prior-run-1",
      resolvedInstrumentIds: ["SSE:600000"],
    }),
    watchlistRevision: "watchlist-1",
    previous: {
      runId: "prior-run-1",
      workflow: "close_review",
      createdAt: "2026-08-06T08:00:00.000Z",
      evidenceFingerprint: "sha256:previous",
      result: previousResult,
    },
  });

  assert.equal(output.evidence.items.some((item) => item.kind === "prior_run"), true);
  assert.equal(output.evidence.ask?.priorRunId, "prior-run-1");
});

test("Ask seals a deterministic diff against the previous Ask Snapshot", async () => {
  const current = marketSnapshot({ instrumentIds: ["SSE:600000"], intervals: ["1d", "1m"], include: ["quotes", "bars"], quoteMode: "corroborated" });
  const previousSnapshot: MarketSnapshot = {
    ...current,
    asOf: "2026-08-06T08:00:00.000Z",
    receivedAt: "2026-08-06T08:00:01.000Z",
    data: { ...current.data, quotes: current.data.quotes.map((quote) => ({ ...quote, price: 10 })) },
  };
  const output = await new AskService({ getCurrentSnapshot: async () => current }).execute({
    runId: "ask-run-diff",
    command: ask(),
    watchlistRevision: "watchlist-1",
    previousSnapshot,
  });

  const diff = output.evidence.items.find((item) => item.kind === "snapshot_diff");
  assert.ok(diff);
  assert.equal((diff.value as { changes: Array<{ current?: number }> }).changes[0]?.current, 12);
});

test("Ask resumes a compare-previous-run checkpoint without rereading the prior Run or Market Facts", async () => {
  const command = ask({
    scope: "compare_previous_run",
    priorRunId: "prior-run-1",
    resolvedInstrumentIds: ["SSE:600000"],
  });
  const previous: AgentResult = {
    status: "success",
    headline: "Earlier review",
    summary: "earlier",
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: "sha256:previous",
    mode: "market-only",
  };
  let checkpoint: Parameters<AskService["execute"]>[0]["checkpoint"];
  const first = await new AskService({ getCurrentSnapshot: async (input) => marketSnapshot(input) }).execute({
    runId: "ask-run-checkpoint",
    command,
    watchlistRevision: "watchlist-1",
    previous: {
      runId: "prior-run-1",
      workflow: "close_review",
      createdAt: "2026-08-06T08:00:00.000Z",
      evidenceFingerprint: "sha256:previous",
      result: previous,
    },
    onCheckpoint: async (value) => { checkpoint = value; },
  });
  assert.ok(checkpoint);

  const resumed = await new AskService({
    getCurrentSnapshot: async () => { throw new Error("Market Facts must not be recollected after evidence_sealed"); },
  }, undefined, {
    retrieve: async () => { throw new Error("Signal Memory must not be reread after evidence_sealed"); },
  }).execute({
    runId: "ask-run-checkpoint",
    command,
    watchlistRevision: "watchlist-1",
    checkpoint,
  });

  assert.equal(resumed.evidence.fingerprint, first.evidence.fingerprint);
  assert.equal(resumed.evidence.ask?.priorRunId, "prior-run-1");
});

test("relative performance seals Research Facts once and resumes without recollecting them", async () => {
  const command = ask({ scope: "relative_performance", instrumentId: "SSE:600000" });
  const research = researchFactBundleFixture();
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  let researchCalls = 0;
  let checkpoint: Parameters<AskService["execute"]>[0]["checkpoint"];
  const first = await new AskService(
    { getCurrentSnapshot: async (input) => ({ ...marketSnapshot(input), asOf: research.observationCutoff }) },
    undefined,
    undefined,
    {
      async materialize(input) {
        researchCalls += 1;
        assert.deepEqual(input, {
          purpose: "relative_performance",
          instrumentIds: ["SSE:600000"],
          selectedInstrumentId: "SSE:600000",
          observationCutoff: "2026-08-14T07:00:00.000Z",
        });
        return research;
      },
    },
  ).execute({
    runId: "ask-run-research",
    command,
    watchlistRevision: "watchlist-1",
    onCheckpoint: async (value) => { checkpoint = value; },
  });

  assert.equal(researchCalls, 1);
  assert.equal(checkpoint?.research?.fingerprint, research.fingerprint);
  assert.equal(first.evidence.items.filter((item) => (item.value as { type?: unknown })?.type === "research_fact").length, research.facts.length);
  assert.ok(first.evidence.items.some((item) => item.kind === "limitation" && JSON.stringify(item.value).includes("CAPABILITY_NOT_IMPLEMENTED")));
  checkpoint = await createRunCheckpoint(checkpoint!.snapshot, {
    ...checkpoint!.evidence,
    items: [...checkpoint!.evidence.items, {
      id: "ask-run-research:research:limitation:scope",
      kind: "limitation",
      origin: "server-observed",
      reliable: true,
      value: { type: "research_scope", code: "RESEARCH_SCOPE_PARTIAL", includedInstrumentIds: ["SSE:600000"], omittedInstrumentIds: ["SSE:600001", "SSE:600002"] },
    }],
  }, checkpoint!.research);

  const resumed = await new AskService(
    { getCurrentSnapshot: async () => { throw new Error("Market Facts must not be recollected after evidence_sealed"); } },
    undefined,
    undefined,
    { materialize: async () => { throw new Error("Research Facts must not be recollected after evidence_sealed"); } },
  ).execute({
    runId: "ask-run-research",
    command,
    watchlistRevision: "watchlist-1",
    checkpoint,
  });

  assert.equal(resumed.evidence.fingerprint, first.evidence.fingerprint);
  assert.equal(researchCalls, 1);
  assert.match(resumed.result.outcome?.evidence.limitations.find((item) => item.code === "RESEARCH_SCOPE_PARTIAL")?.message ?? "", /另有 2 个标的/);
});

test("news and announcements seals company-update financial facts once and replays without Research I/O", async () => {
  const command = ask({ scope: "news_and_announcements", instrumentId: "SSE:600000" });
  const research = await companyUpdateResearch();
  let researchCalls = 0;
  let checkpoint: Parameters<AskService["execute"]>[0]["checkpoint"];
  const first = await new AskService(
    { getCurrentSnapshot: async (input) => marketSnapshot(input) },
    undefined,
    undefined,
    { async materialize(input) {
      researchCalls += 1;
      assert.deepEqual(input, {
        purpose: "company_update",
        instrumentIds: ["SSE:600000"],
        selectedInstrumentId: "SSE:600000",
        observationCutoff: "2026-08-07T08:00:00.000Z",
      });
      return research;
    } },
  ).execute({ runId: "ask-company-update", command, watchlistRevision: "watchlist-1", onCheckpoint: async (value) => { checkpoint = value; } });

  assert.equal(researchCalls, 1);
  assert.equal(checkpoint?.research?.purpose, "company_update");
  assert.equal(first.evidence.items.some((item) => (item.value as { type?: unknown; fact?: { kind?: unknown } })?.type === "research_fact" && (item.value as { fact?: { kind?: unknown } }).fact?.kind === "financial_metric"), true);

  const replayed = await new AskService(
    { getCurrentSnapshot: async () => { throw new Error("Market Facts must not be recollected after evidence_sealed"); } },
    undefined,
    undefined,
    { materialize: async () => { throw new Error("Research Facts must not be recollected after evidence_sealed"); } },
  ).execute({ runId: "ask-company-update", command, watchlistRevision: "watchlist-1", checkpoint });

  assert.equal(replayed.evidence.fingerprint, first.evidence.fingerprint);
  assert.equal(researchCalls, 1);
});

test("news and announcements does not request company-update research while the runtime gate is disabled", async () => {
  let researchCalls = 0;
  let checkpoint: Parameters<AskService["execute"]>[0]["checkpoint"];
  await new AskService(
    { getCurrentSnapshot: async (input) => marketSnapshot(input) },
    undefined,
    undefined,
    { async materialize() { researchCalls += 1; throw new Error("company update must remain disabled"); } },
    { companyUpdateEnabled: false },
  ).execute({
    runId: "ask-company-update-disabled",
    command: ask({ scope: "news_and_announcements", instrumentId: "SSE:600000" }),
    watchlistRevision: "watchlist-1",
    onCheckpoint: async (value) => { checkpoint = value; },
  });

  assert.equal(researchCalls, 0);
  assert.equal(checkpoint?.research, undefined);
});

test("weekend company update does not bind financial freshness to the effective trading session", async () => {
  const asOf = "2026-08-16T02:00:00.000Z";
  const research = await companyUpdateResearch(asOf);
  let researchRequest: Parameters<NonNullable<ConstructorParameters<typeof AskService>[3]>["materialize"]>[0] | undefined;
  await new AskService(
    { getCurrentSnapshot: async (input) => weekendSnapshot(input, asOf) },
    undefined,
    undefined,
    { async materialize(input) { researchRequest = input; return research; } },
  ).execute({ runId: "ask-weekend-company-update", command: ask({ scope: "news_and_announcements", instrumentId: "SSE:600000" }), watchlistRevision: "watchlist-1" });

  assert.equal(researchRequest?.purpose, "company_update");
  assert.equal(Object.hasOwn(researchRequest ?? {}, "expectedLatestSessionDate"), false);
});

test("Ask never recollects Research Facts for a legacy checkpoint without research", async () => {
  let checkpoint: Parameters<AskService["execute"]>[0]["checkpoint"];
  await new AskService({ getCurrentSnapshot: async (input) => marketSnapshot(input) }).execute({
    runId: "ask-run-legacy-checkpoint",
    command: ask({ instrumentId: "SSE:600000" }),
    watchlistRevision: "watchlist-1",
    onCheckpoint: async (value) => { checkpoint = value; },
  });
  assert.ok(checkpoint);
  assert.equal(checkpoint.research, undefined);

  const resumed = await new AskService(
    { getCurrentSnapshot: async () => { throw new Error("Market Facts must not be recollected after evidence_sealed"); } },
    undefined,
    undefined,
    { materialize: async () => { throw new Error("Legacy checkpoint must not trigger Research Fact collection"); } },
  ).execute({
    runId: "ask-run-legacy-checkpoint",
    command: ask({ instrumentId: "SSE:600000" }),
    watchlistRevision: "watchlist-1",
    checkpoint,
  });

  assert.equal(resumed.evidence.fingerprint, checkpoint.evidence.fingerprint);
  assert.equal(resumed.result.outcome?.evidence.limitations.some((item) => item.code === "RESEARCH_SCOPE_PARTIAL"), false);
});

test("Ask rejects a market response that does not echo the sealed fixed plan", async () => {
  const service = new AskService({
    getCurrentSnapshot: async (input) => marketSnapshot({ ...input, include: ["quotes", "news"] }),
  });
  await assert.rejects(
    service.execute({ runId: "ask-run-mismatch", command: ask(), watchlistRevision: "watchlist-1" }),
    /ASK_SNAPSHOT_SCOPE_MISMATCH/,
  );
});

test("Ask seals the snapshot session, freshness, and required capability state for narration", async () => {
  const service = new AskService({
    getCurrentSnapshot: async (input) => ({
      ...marketSnapshot(input),
      data: {
        ...marketSnapshot(input).data,
        status: [{
          exchange: "SSE",
          open: true,
          session: "open",
          calendarDate: "2026-08-07",
          marketTimestamp: "2026-08-07T08:00:00.000Z",
          asOf: "2026-08-07T08:00:00.000Z",
          receivedAt: "2026-08-07T08:00:01.000Z",
          freshness: "fresh",
          quality: "operational",
          reliable: true,
          source: "calendar-fixture",
          warnings: [],
        }],
      },
      capabilities: [{ id: "quotes", status: "operational", required: true, asOf: "2026-08-07T08:00:00.000Z", receivedAt: "2026-08-07T08:00:01.000Z", freshness: "fresh", warnings: [], attempts: [] }],
    }),
  });

  const output = await service.execute({ runId: "ask-run-context", command: ask(), watchlistRevision: "watchlist-1" });
  const snapshotContext = output.evidence.items.find((item) => {
    const value = item.value as { type?: unknown };
    return value?.type === "snapshot_context";
  });

  assert.ok(snapshotContext);
  assert.equal(snapshotContext.reliable, true);
  assert.deepEqual(snapshotContext.value, {
    type: "snapshot_context",
    asOf: "2026-08-07T08:00:00.000Z",
    receivedAt: "2026-08-07T08:00:01.000Z",
    marketTimestamp: "2026-08-07T08:00:00.000Z",
    quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], unavailableCapabilities: [] },
    markets: [{ exchange: "SSE", open: true, session: "open", calendarDate: "2026-08-07", marketTimestamp: "2026-08-07T08:00:00.000Z", asOf: "2026-08-07T08:00:00.000Z", receivedAt: "2026-08-07T08:00:01.000Z", freshness: "fresh", quality: "operational", reliable: true, source: "calendar-fixture", warnings: [] }],
    capabilities: [{ id: "quotes", status: "operational", required: true, asOf: "2026-08-07T08:00:00.000Z", freshness: "fresh", warnings: [] }],
  });
});
