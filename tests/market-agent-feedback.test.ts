import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getAgentRun,
  MarketAgentApiError,
  sendRunFeedback,
} from "../src/features/market-agent/client.ts";
import {
  createRunFeedbackState,
  runFeedbackReducer,
  RunFeedbackControl,
} from "../src/features/market-agent/RunFeedbackControl.tsx";
import { syncAnswerFeedback } from "../src/features/market-agent/AskPanel.tsx";
import { AgentErrorNotice } from "../src/features/market-agent/AgentToday.tsx";
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

test("private API redirects become an explicit Access recovery error", async (context) => {
  const calls: Array<RequestInit | undefined> = [];
  context.mock.method(globalThis, "fetch", async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push(init);
    return new Response(null, { status: 302 });
  });

  await assert.rejects(
    sendRunFeedback("run-1", "helpful"),
    (error: unknown) => error instanceof MarketAgentApiError
      && error.code === "ACCESS_REQUIRED"
      && error.status === 401,
  );
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.credentials, "same-origin");
});

test("a rejected private fetch probes Access before classifying the failure", async (context) => {
  let call = 0;
  context.mock.method(globalThis, "fetch", async () => {
    call += 1;
    if (call === 1) throw new TypeError("Failed to fetch");
    return new Response(null, { status: 302 });
  });

  await assert.rejects(
    sendRunFeedback("run-1", "helpful"),
    (error: unknown) => error instanceof MarketAgentApiError
      && error.code === "ACCESS_REQUIRED",
  );
  assert.equal(call, 2);
});

test("an unavailable Access probe preserves a network diagnosis", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(
    sendRunFeedback("run-1", "helpful"),
    (error: unknown) => error instanceof MarketAgentApiError
      && error.code === "MARKET_AGENT_NETWORK_FAILED"
      && !error.message.includes("Access"),
  );
});

test("an intentional request abort is not rewritten as a network or Access failure", async (context) => {
  let call = 0;
  context.mock.method(globalThis, "fetch", async () => {
    call += 1;
    throw new DOMException("Aborted", "AbortError");
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    getAgentRun("run-1", controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(call, 1);
});

test("Access failures expose an explicit reauthorization action", () => {
  const source = renderToStaticMarkup(createElement(AgentErrorNotice, {
    error: "Cloudflare Access 登录状态已失效，请重新授权后刷新。",
    accessRequired: true,
  }));

  assert.match(source, /重新授权/);
  assert.match(source, /\/api\/private\/session\?service=market-agent&amp;returnTo=/);
  assert.match(source, /target="_blank"/);
});

test("network failures do not expose a misleading reauthorization action", () => {
  const source = renderToStaticMarkup(createElement(AgentErrorNotice, {
    error: "无法连接 Market Agent，请检查网络后重试。",
    accessRequired: false,
  }));

  assert.match(source, /检查网络后重试/);
  assert.doesNotMatch(source, /重新授权/);
  assert.doesNotMatch(source, /api\/private\/session/);
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
