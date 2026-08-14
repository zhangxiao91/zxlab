import assert from "node:assert/strict";
import test from "node:test";
import {
  askEvidencePlan,
  resolveAskScope,
} from "./ask-plan.ts";
import {
  validateBrowserAskIntent,
  type MarketAgentAskCommand,
  type PortfolioSnapshot,
  type SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";

const snapshot: PortfolioSnapshot = {
  id: "portfolio-1",
  schemaVersion: "portfolio-snapshot.v1",
  sourceRevision: "risk:portfolio-1",
  calculatedAt: "2026-08-07T08:00:00.000Z",
  effectiveAt: "2026-08-07T08:00:00.000Z",
  expiresAt: "2026-08-08T08:00:00.000Z",
  positions: [{ instrumentId: "SSE:600000", quantity: 100, averageCost: 10 }],
  cash: 100,
  rulesVersion: "risk.v1",
  reliable: true,
  warnings: [],
  fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  createdAt: "2026-08-07T08:00:00.000Z",
  stoppedAt: null,
};

const previous: Pick<SealedEvidenceBundle, "instrumentIds"> = { instrumentIds: ["SSE:600000", "SZSE:000001"] };

function ask(overrides: Partial<MarketAgentAskCommand> = {}): MarketAgentAskCommand {
  return {
    workflow: "ask",
    scope: "today_change",
    profileId: "profile-1",
    trigger: "manual",
    idempotencyKey: "ask-intent-1",
    resolvedInstrumentIds: [],
    ...overrides,
  };
}

test("Ask input is scope-bound and cannot supply server-only planning fields", () => {
  assert.deepEqual(validateBrowserAskIntent({ scope: "today_change", instrumentId: "sse:600000", idempotencyKey: "ask-input-1" }), []);
  assert.ok(validateBrowserAskIntent({ scope: "today_change", idempotencyKey: "question hidden in metadata" }).includes("idempotencyKey is invalid"));
  assert.match(
    validateBrowserAskIntent({ scope: "invent_a_tool", idempotencyKey: "ask-input-1", marketUrl: "https://example.invalid" }).join("\n"),
    /marketUrl is not allowed.*scope is invalid/s,
  );
  assert.match(
    validateBrowserAskIntent({ scope: "today_change", idempotencyKey: "ask-input-1", resolvedInstrumentIds: ["SSE:600000"] }).join("\n"),
    /server-only fields are not allowed/,
  );
});

test("every Ask scope resolves through a static market request plan", () => {
  const relative = askEvidencePlan("relative_performance");
  assert.deepEqual(relative.include, ["quotes", "bars"]);
  assert.equal(relative.requiresCorroboratedQuotes, true);
  assert.equal(askEvidencePlan("news_and_announcements").quoteMode, "fallback");
});

test("Ask scope resolution rejects missing requirements without expanding the request", () => {
  const relative = resolveAskScope(ask({ scope: "relative_performance", instrumentId: "SSE:600000" }), null, null, null);
  assert.match(relative.clarification ?? "", /观察列表/);

  const portfolio = resolveAskScope(ask({ scope: "portfolio_impact", instrumentId: "SZSE:000001" }), null, snapshot, null);
  assert.match(portfolio.clarification ?? "", /当前持仓/);

  const comparison = resolveAskScope(ask({ scope: "compare_previous_run" }), null, null, previous);
  assert.deepEqual(comparison.instrumentIds, ["SSE:600000", "SZSE:000001"]);
  assert.match(
    resolveAskScope(ask({ scope: "compare_previous_run", instrumentId: "SSE:600000" }), null, null, previous).clarification ?? "",
    /完整标的范围/,
  );
});
