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

test("Ask rejects a market response that does not echo the sealed fixed plan", async () => {
  const service = new AskService({
    getCurrentSnapshot: async (input) => marketSnapshot({ ...input, include: ["quotes", "news"] }),
  });
  await assert.rejects(
    service.execute({ runId: "ask-run-mismatch", command: ask(), watchlistRevision: "watchlist-1" }),
    /ASK_SNAPSHOT_SCOPE_MISMATCH/,
  );
});
