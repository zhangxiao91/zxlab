import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvidenceLimitation, RunOutcome, RunTiming, RunTraceEvent, SealedEvidenceBundle, ToolTraceEvent } from "@zxlab/market-agent-schema";
import { degradedTool, projectRunElapsed, RunActivity } from "../src/features/market-agent/AskPanel.tsx";
import { clearRetryKeyForRun, mergeRunTraceEvents, mergeToolTraceEvents, retryKeyForRun } from "../src/features/market-agent/run-state.ts";

function outcome(limitations: EvidenceLimitation[]): RunOutcome {
  return {
    execution: "completed",
    narration: { source: "model", model: "test-model", fallbackIndex: 0 },
    evidence: { coverage: limitations.length ? "limited" : "sufficient", delivery: "primary", fallbackCapabilities: [], limitations },
    mode: "market-only",
  };
}

test("run activity attributes Market Snapshot degradation only to market limitations", () => {
  const quoteLimitation: EvidenceLimitation = { code: "CAPABILITY_NOT_FRESH", capability: "quotes", severity: "material", message: "quote stale" };

  assert.equal(degradedTool("Market Snapshot", [], outcome([quoteLimitation])), true);
  assert.equal(degradedTool("Evidence Assembler", [], outcome([quoteLimitation])), false);
});

test("run activity attributes Research Fact limitations to evidence assembly", () => {
  const researchLimitation: EvidenceLimitation = { code: "BENCHMARK_MAPPING_MISSING", capability: "research:market_baselines", severity: "material", message: "mapping missing" };

  assert.equal(degradedTool("Market Snapshot", [], outcome([researchLimitation])), false);
  assert.equal(degradedTool("Evidence Assembler", [], outcome([researchLimitation])), true);
});

test("failed Run without trace does not invent a failure stage", () => {
  const source = renderToStaticMarkup(createElement(RunActivity, {
    status: "failed",
    runId: "run-failed",
  }));

  assert.match(source, /尚未读取到服务器运行事件/);
  assert.doesNotMatch(source, /事实收集|Evidence 已封存|报告生成|结果校验/);
  assert.equal((source.match(/<li/g) ?? []).length, 0);
});

test("Run activity renders only persisted trace events and server durations", () => {
  const events: RunTraceEvent[] = [
    traceEvent({ id: "trace-1", sequence: 1, type: "run_created", occurredAt: "2026-08-16T08:00:00.000Z" }),
    traceEvent({ id: "trace-2", sequence: 2, type: "stage_started", stage: "collecting", occurredAt: "2026-08-16T08:00:01.000Z" }),
    traceEvent({ id: "trace-3", sequence: 3, type: "stage_completed", stage: "collecting", occurredAt: "2026-08-16T08:00:03.000Z", durationMs: 2_000 }),
    traceEvent({ id: "trace-4", sequence: 4, type: "run_completed", stage: "success", occurredAt: "2026-08-16T08:00:09.000Z", durationMs: 9_000 }),
  ];
  const source = renderToStaticMarkup(createElement(RunActivity, {
    status: "success",
    runId: "run-1",
    trace: { runId: "run-1", timing: terminalTiming(), events },
  }));

  assert.match(source, /真实运行记录/);
  assert.match(source, /事实收集完成/);
  assert.match(source, /2\.0 秒/);
  assert.match(source, /总耗时 9\.0 秒/);
  assert.doesNotMatch(source, /报告生成中/);
  assert.equal((source.match(/<li/g) ?? []).length, 4);
});

test("Run activity merges tool trace chronologically and only renders safe metadata", () => {
  const source = renderToStaticMarkup(createElement(RunActivity, {
    status: "success",
    runId: "run-1",
    trace: {
      runId: "run-1",
      timing: terminalTiming(),
      events: [traceEvent({ id: "trace-2", sequence: 2, type: "stage_started", stage: "collecting", occurredAt: "2026-08-16T08:00:02.000Z" })],
    },
    toolTrace: {
      runId: "run-1",
      events: [{
        ...toolTraceEvent({ occurredAt: "2026-08-16T08:00:01.000Z" }),
        question: "secret question",
        result: { raw: "raw output" },
        thought: "private reasoning",
      } as unknown as ToolTraceEvent],
    },
  }));

  assert.match(source, /财务工具执行完成/);
  assert.match(source, /模型选择/);
  assert.match(source, /1\.3 秒/);
  assert.match(source, /abcdef012345/);
  assert.match(source, /尚未确认封存到 Evidence/);
  assert.ok(source.indexOf("财务工具执行完成") < source.indexOf("事实收集开始"));
  assert.doesNotMatch(source, /secret question|raw output|private reasoning/);
});

test("completed tool trace claims Evidence sealing only after the matching Research fingerprint is present", () => {
  const fingerprint = `sha256:${"abcdef0123456789".repeat(4)}` as const;
  const evidence = {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "profile-1",
    workflow: "ask",
    watchlistRevision: "watchlist-1",
    instrumentIds: ["SSE:600000"],
    items: [{
      id: "run-1:research:0",
      kind: "market_fact",
      origin: "server-observed",
      reliable: true,
      value: { type: "research_fact", researchFingerprint: fingerprint },
    }],
    contextUses: [],
    fingerprint: `sha256:${"1".repeat(64)}`,
    sealedAt: "2026-08-16T08:00:03.000Z",
  } satisfies SealedEvidenceBundle;
  const source = renderToStaticMarkup(createElement(RunActivity, {
    status: "success",
    runId: "run-1",
    evidence,
    toolTrace: { runId: "run-1", events: [toolTraceEvent({ researchFingerprint: fingerprint })] },
  }));

  assert.match(source, /结果已封存到 Evidence/);
  assert.doesNotMatch(source, /尚未确认封存到 Evidence/);
});

test("live elapsed advances only from a server timing snapshot", () => {
  const timing: RunTiming = {
    queuedAt: "2026-08-16T08:00:00.000Z",
    startedAt: "2026-08-16T08:00:01.000Z",
    updatedAt: "2026-08-16T08:00:03.000Z",
    completedAt: null,
    elapsedMs: 2_000,
    durationMs: null,
    serverNow: "2026-08-16T08:00:03.000Z",
  };

  assert.equal(projectRunElapsed(timing, false, 2_500), 4_500);
  assert.equal(projectRunElapsed({ ...timing, startedAt: null }, false, 3_600_000), 2_000);
  assert.equal(projectRunElapsed({ ...timing, durationMs: 7_250, completedAt: "2026-08-16T08:00:08.250Z" }, true, 3_600_000), 7_250);
  assert.equal(projectRunElapsed(undefined, false, 2_500), null);
});

test("active Run exposes cancel while failed and cancelled Runs expose retry", () => {
  const active = renderToStaticMarkup(createElement(RunActivity, {
    status: "generating",
    runId: "run-active",
    trace: { runId: "run-active", timing: activeTiming(), events: [] },
    onCancel: async () => undefined,
    onRetry: async () => undefined,
  }));
  const failed = renderToStaticMarkup(createElement(RunActivity, {
    status: "failed",
    runId: "run-failed",
    trace: { runId: "run-failed", timing: terminalTiming(), events: [] },
    onCancel: async () => undefined,
    onRetry: async () => undefined,
  }));
  const cancelled = renderToStaticMarkup(createElement(RunActivity, {
    status: "cancelled",
    runId: "run-cancelled",
    trace: { runId: "run-cancelled", timing: terminalTiming(), events: [] },
    onCancel: async () => undefined,
    onRetry: async () => undefined,
  }));

  assert.match(active, />取消运行</);
  assert.doesNotMatch(active, />重试</);
  assert.match(failed, />重试</);
  assert.doesNotMatch(failed, />取消运行</);
  assert.match(cancelled, />重试</);
});

test("streamed trace events merge by id and server sequence", () => {
  const persisted = [
    traceEvent({ id: "trace-1", sequence: 1, type: "run_created", occurredAt: "2026-08-16T08:00:00.000Z" }),
    traceEvent({ id: "trace-3", sequence: 3, type: "stage_completed", stage: "collecting", occurredAt: "2026-08-16T08:00:03.000Z" }),
  ];
  const streamed = [
    traceEvent({ id: "trace-2", sequence: 2, type: "stage_started", stage: "collecting", occurredAt: "2026-08-16T08:00:01.000Z" }),
    persisted[1],
  ];

  assert.deepEqual(
    mergeRunTraceEvents(persisted, streamed).map((event) => event.id),
    ["trace-1", "trace-2", "trace-3"],
  );
});

test("trace merge rejects a sequence reused by another persisted event", () => {
  const first = traceEvent({ id: "trace-1", sequence: 1, type: "run_created", occurredAt: "2026-08-16T08:00:00.000Z" });
  const conflict = traceEvent({ id: "trace-other", sequence: 1, type: "stage_started", occurredAt: "2026-08-16T08:00:01.000Z" });
  assert.throws(() => mergeRunTraceEvents([first], [conflict]), /RUN_TRACE_SEQUENCE_CONFLICT/);
});

test("tool trace events merge by id and reject a reused server sequence", () => {
  const first = toolTraceEvent({ id: "tool-trace-1", sequence: 1 });
  const streamed = toolTraceEvent({ id: "tool-trace-2", sequence: 2, type: "started", occurredAt: "2026-08-16T08:00:02.000Z", durationMs: undefined, outcome: undefined, researchFingerprint: undefined });
  assert.deepEqual(mergeToolTraceEvents([first], [streamed, first]).map((event) => event.id), ["tool-trace-1", "tool-trace-2"]);
  assert.throws(
    () => mergeToolTraceEvents([first], [toolTraceEvent({ id: "other", sequence: 1 })]),
    /TOOL_TRACE_SEQUENCE_CONFLICT/,
  );
  assert.throws(
    () => mergeToolTraceEvents([first], [toolTraceEvent({ outcome: "partial" })]),
    /TOOL_TRACE_CONTENT_CONFLICT/,
  );
});

test("a source Run reuses its retry idempotency key until success clears it", () => {
  const keys = new Map<string, string>();
  let created = 0;
  const create = () => `retry:run-1:key-${++created}`;

  const firstAttempt = retryKeyForRun(keys, "run-1", create);
  const networkRetry = retryKeyForRun(keys, "run-1", create);
  keys.delete("run-1");
  const laterExplicitRetry = retryKeyForRun(keys, "run-1", create);

  assert.equal(networkRetry, firstAttempt);
  assert.notEqual(laterExplicitRetry, firstAttempt);
});

test("a source Run keeps its retry idempotency key across a page reload", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  let created = 0;
  const create = () => `retry:run-1:reload-${++created}`;
  const firstPage = new Map<string, string>();
  const firstAttempt = retryKeyForRun(firstPage, "run-1", create, storage);
  const reloadedPage = new Map<string, string>();

  assert.equal(retryKeyForRun(reloadedPage, "run-1", create, storage), firstAttempt);
  assert.equal(created, 1);

  clearRetryKeyForRun(reloadedPage, "run-1", storage);
  assert.notEqual(retryKeyForRun(new Map(), "run-1", create, storage), firstAttempt);
});

function traceEvent(overrides: Partial<RunTraceEvent> & Pick<RunTraceEvent, "id" | "sequence" | "type" | "occurredAt">): RunTraceEvent {
  return {
    runId: "run-1",
    stage: "queued",
    attempt: 1,
    recoveryGeneration: 0,
    provenance: { source: "market-agent-worker", operation: "run.fail" },
    ...overrides,
  } as unknown as RunTraceEvent;
}

function toolTraceEvent(overrides: Partial<ToolTraceEvent> = {}): ToolTraceEvent {
  return {
    id: "tool-trace-1",
    runId: "run-1",
    invocationId: "invocation-1",
    sequence: 1,
    type: "completed",
    tool: { id: "company_financial_update", version: "1" },
    attempt: 1,
    occurredAt: "2026-08-16T08:00:01.000Z",
    selectionSource: "model",
    durationMs: 1_250,
    outcome: "operational",
    researchFingerprint: `sha256:${"abcdef0123456789".repeat(4)}`,
    provenance: { source: "market-agent-worker", operation: "tool.execute" },
    ...overrides,
  } as ToolTraceEvent;
}

function activeTiming(): RunTiming {
  return {
    queuedAt: "2026-08-16T08:00:00.000Z",
    startedAt: "2026-08-16T08:00:01.000Z",
    updatedAt: "2026-08-16T08:00:03.000Z",
    completedAt: null,
    elapsedMs: 2_000,
    durationMs: null,
    serverNow: "2026-08-16T08:00:03.000Z",
  };
}

function terminalTiming(): RunTiming {
  return {
    ...activeTiming(),
    updatedAt: "2026-08-16T08:00:09.000Z",
    completedAt: "2026-08-16T08:00:09.000Z",
    elapsedMs: 8_000,
    durationMs: 9_000,
    serverNow: "2026-08-16T08:00:09.000Z",
  };
}
