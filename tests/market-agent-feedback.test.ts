import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sendRunFeedback } from "../src/features/market-agent/client.ts";
import {
  createRunFeedbackState,
  runFeedbackReducer,
  RunFeedbackControl,
} from "../src/features/market-agent/RunFeedbackControl.tsx";
import { syncAnswerFeedback } from "../src/features/market-agent/AskPanel.tsx";
import {
  enqueueRunFeedback,
  mergeRunPageWithCurrentFeedback,
  mergeRunWithCurrentFeedback,
} from "../src/features/market-agent/run-state.ts";

test("run feedback client returns the persisted feedback resource", async (context) => {
  const updatedAt = "2026-08-15T12:00:00.000Z";
  context.mock.method(globalThis, "fetch", async () => Response.json({
    feedback: { value: "helpful", updatedAt },
  }));

  const feedback = await sendRunFeedback("run-1", "helpful");

  assert.deepEqual(feedback, { value: "helpful", updatedAt });
});

test("run feedback state moves through saving, saved, and retryable error", () => {
  const idle = createRunFeedbackState(null);
  const saving = runFeedbackReducer(idle, { type: "start", value: "helpful", requestId: 1 });
  assert.deepEqual(saving, { kind: "saving", feedback: null, value: "helpful", requestId: 1 });

  const saved = runFeedbackReducer(saving, {
    type: "saved",
    feedback: { value: "helpful", updatedAt: "2026-08-15T12:00:00.000Z" },
    requestId: 1,
  });
  assert.equal(saved.kind, "saved");

  const changing = runFeedbackReducer(saved, { type: "start", value: "fact_error", requestId: 2 });
  const failed = runFeedbackReducer(changing, { type: "failed", message: "network unavailable", requestId: 2 });
  assert.deepEqual(failed, {
    kind: "error",
    feedback: { value: "helpful", updatedAt: "2026-08-15T12:00:00.000Z" },
    message: "network unavailable",
  });
});

test("an in-flight control keeps a newer shared feedback baseline on failure", () => {
  const saving = runFeedbackReducer(
    createRunFeedbackState(null),
    { type: "start", value: "fact_error", requestId: 2 },
  );
  const synced = runFeedbackReducer(saving, {
    type: "sync",
    feedback: { value: "helpful", updatedAt: "2026-08-15T12:00:00.000Z" },
  });
  const failed = runFeedbackReducer(synced, {
    type: "failed",
    message: "network unavailable",
    requestId: 2,
  });

  assert.deepEqual(failed, {
    kind: "error",
    feedback: { value: "helpful", updatedAt: "2026-08-15T12:00:00.000Z" },
    message: "network unavailable",
  });
});

test("run feedback controls expose pressed and local async state", () => {
  const source = renderToStaticMarkup(createElement(RunFeedbackControl, {
    feedback: { value: "helpful", updatedAt: "2026-08-15T12:00:00.000Z" },
    onSubmit: async (value) => ({ value, updatedAt: "2026-08-15T12:00:00.000Z" }),
  }));

  assert.match(source, /aria-pressed="true"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /已记录“有帮助”/);
});

test("ask answer feedback follows the same run updated from history", () => {
  const answer = {
    id: "run-1",
    workflow: "ask" as const,
    status: "success" as const,
    createdAt: "2026-08-15T11:00:00.000Z",
    updatedAt: "2026-08-15T11:05:00.000Z",
    evidenceFingerprint: "fingerprint",
    feedback: { value: "helpful" as const, updatedAt: "2026-08-15T12:00:00.000Z" },
  };
  const runs = [{
    ...answer,
    feedback: { value: "fact_error" as const, updatedAt: "2026-08-15T12:01:00.000Z" },
  }];

  const synced = syncAnswerFeedback(answer, runs);

  assert.equal(synced?.feedback?.value, "fact_error");
  assert.equal(synced?.feedback?.updatedAt, "2026-08-15T12:01:00.000Z");
});

test("stale refresh and stream payloads cannot roll back newer feedback", () => {
  const current = {
    id: "run-1",
    workflow: "ask" as const,
    status: "success" as const,
    createdAt: "2026-08-15T11:00:00.000Z",
    updatedAt: "2026-08-15T11:05:00.000Z",
    evidenceFingerprint: "fingerprint",
    feedback: { value: "fact_error" as const, updatedAt: "2026-08-15T12:01:00.000Z" },
  };
  const stale = {
    ...current,
    feedback: { value: "helpful" as const, updatedAt: "2026-08-15T12:00:00.000Z" },
  };
  const missing = { ...current, feedback: undefined };

  assert.equal(mergeRunWithCurrentFeedback(current, stale).feedback?.value, "fact_error");
  assert.equal(mergeRunWithCurrentFeedback(current, missing).feedback?.value, "fact_error");
  assert.equal(mergeRunPageWithCurrentFeedback([current], [stale])[0]?.feedback?.value, "fact_error");
});

test("a newer server feedback value still replaces the local value", () => {
  const current = {
    id: "run-1",
    workflow: "ask" as const,
    status: "success" as const,
    createdAt: "2026-08-15T11:00:00.000Z",
    updatedAt: "2026-08-15T11:05:00.000Z",
    evidenceFingerprint: "fingerprint",
    feedback: { value: "helpful" as const, updatedAt: "2026-08-15T12:00:00.000Z" },
  };
  const incoming = {
    ...current,
    feedback: { value: "missing_factor" as const, updatedAt: "2026-08-15T12:02:00.000Z" },
  };

  assert.equal(mergeRunWithCurrentFeedback(current, incoming).feedback?.value, "missing_factor");
});

test("a purged run clears locally retained feedback", () => {
  const current = {
    id: "run-1",
    workflow: "ask" as const,
    status: "success" as const,
    createdAt: "2026-08-15T11:00:00.000Z",
    updatedAt: "2026-08-15T11:05:00.000Z",
    evidenceFingerprint: "fingerprint",
    feedback: { value: "helpful" as const, updatedAt: "2026-08-15T12:00:00.000Z" },
  };
  const purged = {
    ...current,
    feedback: null,
    payloadPurgedAt: "2026-08-15T12:03:00.000Z",
  };

  assert.equal(mergeRunWithCurrentFeedback(current, purged).feedback, null);
});

test("feedback writes for the same run execute in user intent order", async () => {
  const queue = new Map();
  const order: string[] = [];
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = enqueueRunFeedback(queue, "run-1", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return { value: "helpful", updatedAt: "2026-08-15T12:00:00.000Z" };
  });
  const second = enqueueRunFeedback(queue, "run-1", async () => {
    order.push("second:start");
    return { value: "fact_error", updatedAt: "2026-08-15T12:01:00.000Z" };
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  const [, finalFeedback] = await Promise.all([first, second]);

  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  assert.equal(finalFeedback.value, "fact_error");
  assert.equal(queue.size, 0);
});
