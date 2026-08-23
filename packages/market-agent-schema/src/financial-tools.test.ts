import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_FINANCIAL_UPDATE_TOOL,
  FINANCIAL_TOOL_POLICY_VERSION,
  isFinancialToolPlannerDecision,
  isFinancialToolRuntimeInput,
  isFinancialToolSessionReceipt,
  isToolTrace,
  isToolTraceEvent,
} from "./index.ts";

const fingerprint = `sha256:${"a".repeat(64)}`;
const tool = { id: "company_financial_update", version: "1" } as const;
const baseEvent = {
  id: "tool-event-1",
  runId: "run-1",
  invocationId: "tool-invocation-1",
  sequence: 1,
  tool,
  attempt: 1,
  occurredAt: "2026-08-23T01:00:00.000Z",
  selectionSource: "model",
};

test("financial tool policy exposes one versioned read-only definition", () => {
  assert.equal(FINANCIAL_TOOL_POLICY_VERSION, "financial-tools.v1");
  assert.deepEqual(COMPANY_FINANCIAL_UPDATE_TOOL, tool);
});

test("planner decisions accept only the fixed invoke or skip protocol", () => {
  assert.equal(isFinancialToolPlannerDecision({ decision: "invoke", tool: "company_financial_update.v1" }), true);
  assert.equal(isFinancialToolPlannerDecision({ decision: "skip" }), true);
  assert.equal(isFinancialToolPlannerDecision({ decision: "invoke", tool: "company_financial_update.v1", arguments: {} }), false);
  assert.equal(isFinancialToolPlannerDecision({ decision: "skip", reason: "private model text" }), false);
  assert.equal(isFinancialToolPlannerDecision({ decision: "invoke", tool: "other.v1" }), false);
});

test("runtime input is a strict server-owned single-instrument request", () => {
  const input = {
    runId: "run-1",
    profileId: "profile-1",
    attempt: 1,
    scope: "news_and_announcements",
    selectedInstrumentId: "SSE:600000",
    snapshotAsOf: "2026-08-22T07:00:00.000Z",
    question: "最近的财务变化是什么？",
  };
  assert.equal(isFinancialToolRuntimeInput(input), true);
  assert.equal(isFinancialToolRuntimeInput({ ...input, provider: "eastmoney" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, formula: "invented" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, knowledgeCutoff: "2025-01-01T00:00:00.000Z" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, scope: "today_change" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, selectedInstrumentId: "SSE:600000,SZSE:000001" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, question: " ".repeat(801) }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, snapshotAsOf: "0" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, snapshotAsOf: "2026-08-22" }), false);
  assert.equal(isFinancialToolRuntimeInput({ ...input, snapshotAsOf: "2026-08-22 07:00:00" }), false);
});

test("session receipt distinguishes a model skip from an immutable completed execution", () => {
  assert.equal(isFinancialToolSessionReceipt({
    policyVersion: "financial-tools.v1",
    runId: "run-1",
    status: "skipped",
    selectionSource: "model",
    invocationId: "tool-invocation-1",
    tool,
    attempt: 1,
    completedAt: "2026-08-23T01:00:00.000Z",
  }), true);
  const completed = {
    policyVersion: "financial-tools.v1",
    runId: "run-1",
    status: "completed",
    selectionSource: "policy_fallback",
    execution: {
      invocationId: "tool-invocation-1",
      tool,
      attempt: 1,
      outcome: "partial",
      researchFingerprint: fingerprint,
      startedAt: "2026-08-23T01:00:00.000Z",
      completedAt: "2026-08-23T01:00:01.500Z",
      durationMs: 1_500,
    },
  };
  assert.equal(isFinancialToolSessionReceipt(completed), true);
  assert.equal(isFinancialToolSessionReceipt({ ...completed, rawResult: "private" }), false);
  assert.equal(isFinancialToolSessionReceipt({
    policyVersion: "financial-tools.v1",
    runId: "run-1",
    status: "skipped",
    selectionSource: "policy_fallback",
    invocationId: "tool-invocation-1",
    tool,
    attempt: 1,
    completedAt: "2026-08-23T01:00:00.000Z",
  }), false);
});

test("tool trace validates bounded public events independently from RunTrace", () => {
  const events = [{
    ...baseEvent,
    type: "selected",
    durationMs: 80,
    provenance: { source: "market-agent-worker", operation: "tool.select" },
  }, {
    ...baseEvent,
    id: "tool-event-2",
    sequence: 2,
    type: "started",
    occurredAt: "2026-08-23T01:00:00.100Z",
    provenance: { source: "market-agent-worker", operation: "tool.execute" },
  }, {
    ...baseEvent,
    id: "tool-event-3",
    sequence: 3,
    type: "completed",
    occurredAt: "2026-08-23T01:00:01.500Z",
    durationMs: 1_400,
    outcome: "partial",
    researchFingerprint: fingerprint,
    provenance: { source: "market-agent-worker", operation: "tool.execute" },
  }];

  assert.equal(events.every(isToolTraceEvent), true);
  assert.equal(isToolTrace({ runId: "run-1", events }), true);
  assert.equal(isToolTrace({ runId: "run-1", events: [events[1], events[0]] }), false);
  assert.equal(isToolTrace({ runId: "other-run", events }), false);
});

test("tool trace rejects raw inputs, outputs, model text and malformed variants", () => {
  const selected = {
    ...baseEvent,
    type: "selected",
    durationMs: 80,
    provenance: { source: "market-agent-worker", operation: "tool.select" },
  };
  assert.equal(isToolTraceEvent({ ...selected, question: "private" }), false);
  assert.equal(isToolTraceEvent({ ...selected, result: { raw: "provider body" } }), false);
  assert.equal(isToolTraceEvent({ ...selected, thought: "private model text" }), false);
  assert.equal(isToolTraceEvent({ ...selected, code: "NOT_ALLOWED_HERE" }), false);
  assert.equal(isToolTraceEvent({ ...selected, provenance: { ...selected.provenance, error: "free text" } }), false);
  assert.equal(isToolTraceEvent({ ...selected, selectionSource: "browser" }), false);
  assert.equal(isToolTraceEvent({ ...selected, occurredAt: "0" }), false);
  assert.equal(isToolTraceEvent({
    ...baseEvent,
    type: "skipped",
    durationMs: 80,
    code: "FINANCIAL_TOOL_NOT_SELECTED",
    provenance: { source: "market-agent-worker", operation: "tool.skip" },
  }), true);
  assert.equal(isToolTraceEvent({
    ...baseEvent,
    type: "failed",
    durationMs: 35_000,
    code: "FINANCIAL_TOOL_TIMEOUT",
    provenance: { source: "market-agent-worker", operation: "tool.execute" },
  }), true);
});
