import assert from "node:assert/strict";
import test from "node:test";
import { COMPANY_FINANCIAL_UPDATE_TOOL, type AgentRun, type RunStatus, type RunTraceEvent, type ToolTraceEvent } from "@zxlab/market-agent-schema";
import { createRunEventStream } from "./run-stream.ts";

test("Run stream emits real statuses, answer deltas, and the terminal Run", async () => {
  const statuses: RunStatus[] = [
    "collecting",
    "evidence_sealed",
    "generating",
    "validating",
    "success",
  ];
  const initialRun = run("queued");
  const repository = {
    async get() {
      return run(statuses.shift() ?? "success");
    },
    async listTraceAfter(_runId: string, _profileId: string, afterSequence: number) {
      return traceEvents().filter((event) => event.sequence > afterSequence);
    },
    async listToolTraceAfter(_runId: string, _profileId: string, afterSequence: number) {
      return toolTraceEvents().filter((event) => event.sequence > afterSequence);
    },
  };
  const response = createRunEventStream(
    new Request("https://agent.example/runs/run-1/stream"),
    repository,
    "run-1",
    "profile-1",
    { initialRun, pollMs: 0, deltaDelayMs: 0, wait: async () => {} },
  );

  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const events = parseEvents(await response.text());
  assert.deepEqual(
    events.filter((event) => event.name === "status").map((event) => event.data.run.status),
    ["queued", "collecting", "evidence_sealed", "generating", "validating"],
  );
  assert.equal(
    events.filter((event) => event.name === "answer_delta").map((event) => event.data.delta).join(""),
    "盘后复盘完成\n\n市场事实已封存并通过校验。",
  );
  assert.equal(events.at(-1)?.name, "done");
  assert.equal(events.at(-1)?.data.run.status, "success");
  assert.deepEqual(
    events.filter((event) => event.name === "trace").map((event) => event.data.event.sequence),
    [1, 2],
  );
  assert.deepEqual(
    events.filter((event) => event.name === "tool_trace").map((event) => event.data.event.sequence),
    [1],
  );
});

function toolTraceEvents(): ToolTraceEvent[] {
  return [{
    id: "tool-trace-1",
    runId: "run-1",
    invocationId: "tool-invocation-1",
    sequence: 1,
    type: "completed",
    tool: COMPANY_FINANCIAL_UPDATE_TOOL,
    attempt: 1,
    occurredAt: "2026-08-11T08:00:01.500Z",
    selectionSource: "model",
    durationMs: 500,
    outcome: "operational",
    researchFingerprint: `sha256:${"a".repeat(64)}`,
    provenance: { source: "market-agent-worker", operation: "tool.execute" },
  }];
}

function traceEvents(): RunTraceEvent[] {
  return [
    { id: "trace-1", runId: "run-1", sequence: 1, type: "run_created", stage: "queued", attempt: 0, recoveryGeneration: 0, occurredAt: "2026-08-11T08:00:00.000Z", provenance: { source: "market-agent-worker", operation: "run.create" } },
    { id: "trace-2", runId: "run-1", sequence: 2, type: "stage_started", stage: "collecting", attempt: 1, recoveryGeneration: 0, occurredAt: "2026-08-11T08:00:01.000Z", provenance: { source: "market-agent-worker", operation: "run.claim" } },
  ];
}

function run(status: RunStatus): AgentRun {
  return {
    id: "run-1",
    profileId: "profile-1",
    workflow: "close_review",
    trigger: "manual",
    status,
    idempotencyKey: "stream-test",
    commandHash: "sha256:test",
    revisionOfRunId: null,
    portfolioSnapshotId: null,
    attempt: 1,
    recoveryGeneration: 0,
    createdAt: "2026-08-11T08:00:00.000Z",
    updatedAt: `2026-08-11T08:00:0${status.length % 10}.000Z`,
    evidenceFingerprint: status === "success" ? "sha256:evidence" : null,
    failure: null,
    ...(status === "success" ? {
      result: {
        status: "success",
        headline: "盘后复盘完成",
        summary: "市场事实已封存并通过校验。",
        observations: [],
        portfolioImpacts: [],
        watchNext: [],
        limitations: [],
        evidenceFingerprint: "sha256:evidence",
        mode: "market-only",
      },
    } : {}),
  };
}

function parseEvents(raw: string): Array<{ name: string; data: Record<string, any> }> {
  return raw.trim().split("\n\n").flatMap((block) => {
    const name = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
    const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return name && data ? [{ name, data: JSON.parse(data) as Record<string, any> }] : [];
  });
}
