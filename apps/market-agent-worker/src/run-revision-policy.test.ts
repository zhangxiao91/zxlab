import assert from "node:assert/strict";
import test from "node:test";
import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { canCreateRunRevision } from "./run-revision-policy.ts";

const baseEvidence: SealedEvidenceBundle = {
  schemaVersion: "market-agent.v1",
  eventRuleVersion: "market-event.v1",
  profileId: "profile-1",
  workflow: "ask",
  watchlistRevision: "watchlist-1",
  instrumentIds: ["SSE:600000"],
  items: [],
  contextUses: [],
  fingerprint: `sha256:${"a".repeat(64)}`,
  sealedAt: "2026-08-16T02:00:00.000Z",
  ask: { scope: "today_change", planVersion: "ask-plan.v1" },
};

test("failed and cancelled Runs retain their normal retry policy", () => {
  assert.equal(canCreateRunRevision("failed", null), true);
  assert.equal(canCreateRunRevision("cancelled", null), true);
  assert.equal(canCreateRunRevision("collecting", null), false);
});

test("only completed legacy Runs without MarketReference may be rerun under current semantics", () => {
  const legacy = {
    ...baseEvidence,
    items: [{
      id: "run-1:snapshot:context",
      kind: "market_fact" as const,
      origin: "server-observed" as const,
      reliable: true,
      value: { type: "snapshot_context", asOf: "2026-08-16T02:00:00.000Z" },
    }],
  };
  const current = {
    ...legacy,
    items: [{
      ...legacy.items[0],
      value: {
        ...legacy.items[0].value,
        reference: {
          requestedCalendarDate: "2026-08-16",
          effectiveTradingDate: "2026-08-14",
          session: "holiday",
          semantics: "last_effective_session",
        },
      },
    }],
  };

  assert.equal(canCreateRunRevision("success", legacy), true);
  assert.equal(canCreateRunRevision("partial", legacy), true);
  assert.equal(canCreateRunRevision("success", current), false);
  assert.equal(canCreateRunRevision("partial", current), false);
});
