import test from "node:test";
import assert from "node:assert/strict";
import { fetchLatestSignal } from "../src/signal.js";

test("fetches and validates latest briefing", async () => {
  const briefing = await fetchLatestSignal({
    baseUrl: "https://signal.example",
    timeoutMs: 1000,
    fetcher: async (input) => {
      assert.equal(input, "https://signal.example/api/briefings/latest");
      return new Response(JSON.stringify({ id: "1", date: "2026-07-22", title: "t", summary: "s", items: [] }), { status: 200 });
    },
  });
  assert.equal(briefing.id, "1");
});
