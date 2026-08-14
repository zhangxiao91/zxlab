import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, MarketAgentAskCommand } from "@zxlab/market-agent-schema";
import type { MarketSnapshot, MarketSnapshotRequest } from "@zxlab/market-schema";
import { AskService } from "./ask-service.ts";

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
