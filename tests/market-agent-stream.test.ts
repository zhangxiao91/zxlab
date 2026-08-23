import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelAgentRun,
  getAgentRunTrace,
  getAgentToolTrace,
  pollAgentRunUntilTerminal,
  retryAgentRun,
  streamAgentRun,
  type AgentRunView,
} from "../src/features/market-agent/client.ts";
import type { RunStatus } from "@zxlab/market-agent-schema";

test("browser Run client consumes chunked status and answer SSE incrementally", async () => {
  const run = fixtureRun("success");
  const payload = [
    `event: status\ndata: ${JSON.stringify({ run: fixtureRun("generating") })}\n\n`,
    "event: answer_delta\ndata: {\"delta\":\"盘后\"}\n\n",
    "event: answer_delta\ndata: {\"delta\":\"复盘\"}\n\n",
    `event: done\ndata: ${JSON.stringify({ run })}\n\n`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of payload) {
        const middle = Math.floor(item.length / 2);
        controller.enqueue(new TextEncoder().encode(item.slice(0, middle)));
        controller.enqueue(new TextEncoder().encode(item.slice(middle)));
      }
      controller.close();
    },
  });
  const statuses: string[] = [];
  let answer = "";
  const completed = await streamAgentRun("run-1", {
    onStatus: (next) => statuses.push(next.status),
    onAnswerDelta: (delta) => { answer += delta; },
  }, {
    fetcher: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });

  assert.deepEqual(statuses, ["generating"]);
  assert.equal(answer, "盘后复盘");
  assert.equal(completed.status, "success");
});

test("browser Run client forwards bounded trace events without inventing activity", async () => {
  const event = {
    id: "trace-2",
    runId: "run-1",
    sequence: 2,
    type: "stage_completed" as const,
    stage: "collecting" as const,
    attempt: 1,
    recoveryGeneration: 0,
    occurredAt: "2026-08-16T08:00:03.000Z",
    durationMs: 2_000,
    provenance: { source: "market-agent-worker" as const, operation: "evidence.seal" as const },
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: trace\ndata: ${JSON.stringify({ event })}\n\n`));
      controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ run: fixtureRun("success") })}\n\n`));
      controller.close();
    },
  });
  const received: unknown[] = [];

  await streamAgentRun("run-1", {
    onTrace: (next) => received.push(next),
  }, {
    fetcher: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });

  assert.deepEqual(received, [event]);
});

test("browser Run client forwards bounded tool trace events independently", async () => {
  const event = toolTraceEvent();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: tool_trace\ndata: ${JSON.stringify({ event })}\n\n`));
      controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ run: fixtureRun("success") })}\n\n`));
      controller.close();
    },
  });
  const received: unknown[] = [];

  await streamAgentRun("run-1", {
    onToolTrace: (next) => received.push(next),
  }, {
    fetcher: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });

  assert.deepEqual(received, [event]);
});

test("trace, tool trace, cancel, and retry clients use the profile-scoped Run control routes", async (context) => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(input).endsWith("/tool-trace")) return Response.json({
      runId: "run-1",
      events: [toolTraceEvent()],
    });
    if (String(input).endsWith("/trace")) return Response.json({
      runId: "run-1",
      timing: fixtureTiming(),
      events: [],
    });
    if (String(input).endsWith("/cancel")) return Response.json({ run: fixtureRun("cancelled") });
    return Response.json({ runId: "run-2", status: "queued", revisionOfRunId: "run-1", created: true });
  });

  const trace = await getAgentRunTrace("run-1");
  const toolTrace = await getAgentToolTrace("run-1");
  await cancelAgentRun("run-1");
  await retryAgentRun("run-1", "retry:run-1:fixed-key");

  assert.equal(trace.runId, "run-1");
  assert.equal(toolTrace.events[0]?.invocationId, "invocation-1");
  assert.deepEqual(requests, [
    { url: "/api/private/market-agent/runs/run-1/trace", method: "GET", body: null },
    { url: "/api/private/market-agent/runs/run-1/tool-trace", method: "GET", body: null },
    { url: "/api/private/market-agent/runs/run-1/cancel", method: "POST", body: null },
    { url: "/api/private/market-agent/runs/run-1/retry", method: "POST", body: { idempotencyKey: "retry:run-1:fixed-key" } },
  ]);
});

test("tool trace client rejects events bound to another Run", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    runId: "run-1",
    events: [toolTraceEvent({ runId: "run-2" })],
  }));

  await assert.rejects(getAgentToolTrace("run-1"), /响应格式无效/);
});

test("retry client rejects a non-queued replacement Run", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ runId: "run-2", status: "generating", revisionOfRunId: "run-1" }));
  await assert.rejects(retryAgentRun("run-1", "retry:run-1:fixed-key"), /响应与来源 Run 不匹配/);
});

test("browser Run stream rejects a trace event bound to another Run", async () => {
  const foreign = traceEvent({ runId: "run-2" });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: trace\ndata: ${JSON.stringify({ event: foreign })}\n\n`));
      controller.close();
    },
  });

  await assert.rejects(
    streamAgentRun("run-1", {}, {
      fetcher: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    }),
    (cause: unknown) => cause instanceof Error && cause.message.includes("不匹配"),
  );
});

test("browser Run stream rejects status and terminal frames bound to another Run", async () => {
  for (const [event, run] of [
    ["status", { ...fixtureRun("generating"), id: "run-2" }],
    ["done", { ...fixtureRun("success"), id: "run-2" }],
    ["done", fixtureRun("generating")],
  ] as const) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify({ run })}\n\n`));
        controller.close();
      },
    });
    await assert.rejects(
      streamAgentRun("run-1", {}, {
        fetcher: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      }),
      /不匹配/,
    );
  }
});

test("trace client rejects cross-Run and non-monotonic persisted events", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({
    runId: "run-1",
    timing: fixtureTiming(),
    events: [
      traceEvent({ id: "trace-2", sequence: 2 }),
      traceEvent({ id: "trace-foreign", runId: "run-2", sequence: 1 }),
    ],
  }));

  await assert.rejects(getAgentRunTrace("run-1"), /响应格式无效/);
});

test("poll fallback treats cancelled as terminal", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json(fixtureRun("cancelled")));
  const seen: string[] = [];
  const run = await pollAgentRunUntilTerminal("run-1", (next) => seen.push(next.status), undefined, 0);
  assert.equal(run.status, "cancelled");
  assert.deepEqual(seen, ["cancelled"]);
});

function traceEvent(overrides: Partial<ReturnType<typeof baseTraceEvent>> = {}) {
  return { ...baseTraceEvent(), ...overrides };
}

function baseTraceEvent() {
  return {
    id: "trace-1",
    runId: "run-1",
    sequence: 1,
    type: "stage_started" as const,
    stage: "collecting" as const,
    attempt: 1,
    recoveryGeneration: 0,
    occurredAt: "2026-08-16T08:00:01.000Z",
    provenance: { source: "market-agent-worker" as const, operation: "run.claim" as const },
  };
}

function toolTraceEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "tool-trace-1",
    runId: "run-1",
    invocationId: "invocation-1",
    sequence: 1,
    type: "completed" as const,
    tool: { id: "company_financial_update" as const, version: "1" as const },
    attempt: 1,
    occurredAt: "2026-08-16T08:00:02.000Z",
    selectionSource: "model" as const,
    durationMs: 1_250,
    outcome: "operational" as const,
    researchFingerprint: `sha256:${"abcdef0123456789".repeat(4)}`,
    provenance: { source: "market-agent-worker" as const, operation: "tool.execute" as const },
    ...overrides,
  };
}

function fixtureTiming() {
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

function fixtureRun(status: RunStatus): AgentRunView {
  return {
    id: "run-1",
    workflow: "close_review",
    status,
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: "2026-08-11T08:00:01.000Z",
    evidenceFingerprint: status === "success" ? "sha256:test" : null,
    ...(status === "success" ? {
      result: {
        status: "success",
        headline: "盘后复盘",
        summary: "完成",
        observations: [],
        portfolioImpacts: [],
        watchNext: [],
        limitations: [],
      },
    } : {}),
  };
}
