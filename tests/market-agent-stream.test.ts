import assert from "node:assert/strict";
import test from "node:test";
import { streamAgentRun, type AgentRunView } from "../src/features/market-agent/client.ts";

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

function fixtureRun(status: string): AgentRunView {
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
