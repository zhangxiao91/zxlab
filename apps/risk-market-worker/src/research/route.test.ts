import assert from "node:assert/strict";
import test from "node:test";
import { validateResearchFactBundle } from "@zxlab/research-fact-schema";
import worker, { handleResearchFactRequest } from "../index.ts";
import { ResearchFactPlane, type DailyHistoryPort, type VersionedBenchmarkMappingPort } from "./fact-plane.ts";

const RESEARCH_TOKEN = "test-market-research-token";
const RUNTIME_TOKEN = "test-runtime-token";
const NOW = "2026-08-14T07:00:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

const history: DailyHistoryPort = {
  async loadDailyHistory({ instrumentId }) {
    return {
      instrumentId,
      provider: "fixture-bars",
      providerVersion: "fixture-bars.v1",
      retrievedAt: NOW,
      bars: Array.from({ length: 251 }, (_, index) => ({
        sessionDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
        close: "100",
        volume: "1000",
        turnover: "5000",
      })),
    };
  },
};
const mappings: VersionedBenchmarkMappingPort = { async findEffectiveBenchmark() { return null; } };

test("research facts route authenticates before the global GET method gate and does not emit public CORS", async () => {
  const response = await worker.fetch(new Request("https://market.example/api/market/research/facts", { method: "POST", headers: { authorization: `Bearer ${RUNTIME_TOKEN}` }, body: "{}" }), { ZX_RUNTIME_SERVICE_TOKEN: RUNTIME_TOKEN, MARKET_RESEARCH_TOKEN: RESEARCH_TOKEN }, ctx);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("authenticated research facts POST materializes a validated bundle", async () => {
  const plane = new ResearchFactPlane({ history, benchmarkMappings: mappings, now: () => NOW });
  const response = await handleResearchFactRequest(new Request("https://market.example/api/market/research/facts", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEARCH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: NOW }),
  }), RESEARCH_TOKEN, plane);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json() as { data: unknown };
  assert.equal(validateResearchFactBundle(body.data).ok, true);
});

test("research facts route returns a safe nonretryable cutoff error", async () => {
  const plane = new ResearchFactPlane({ history, benchmarkMappings: mappings, now: () => NOW });
  const response = await handleResearchFactRequest(new Request("https://market.example/api/market/research/facts", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEARCH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T06:44:59.999Z" }),
  }), RESEARCH_TOKEN, plane);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: "OBSERVATION_CUTOFF_OUT_OF_RANGE", message: "observationCutoff must be within the previous 15 minutes", retryable: false } });
});

test("research facts route does not downgrade history integrity failures", async () => {
  const invalidHistory: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await history.loadDailyHistory(input);
      return { ...loaded, instrumentId: "SSE:600001" };
    },
  };
  const plane = new ResearchFactPlane({ history: invalidHistory, benchmarkMappings: mappings, now: () => NOW });
  const response = await handleResearchFactRequest(new Request("https://market.example/api/market/research/facts", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEARCH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: NOW }),
  }), RESEARCH_TOKEN, plane);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: "RESEARCH_HISTORY_INTEGRITY_FAILURE", message: "Research history failed integrity validation", retryable: false } });
});
