import assert from "node:assert/strict";
import test from "node:test";
import type { DossierFactDelta } from "@zxlab/market-agent-schema";
import { GatewayThesisImpactClassifier } from "./thesis-impact-classifier.ts";

const FP = `sha256:${"a".repeat(64)}` as const;

test("thesis classifier sends only bounded thesis and Fact delta summaries to its dedicated Gateway task", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const classifier = new GatewayThesisImpactClassifier({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "gateway-token",
    fetcher: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        requestId: "gateway-request-1",
        data: {
          json: {
            schemaVersion: "thesis-impact-classifier.v1",
            impacts: [{
              thesisId: "thesis-1",
              impact: "supports",
              explanation: "收入改善可能支持现有论点，但仍需后续报告确认。",
              factDeltaIds: ["delta-1"],
              evidenceIds: ["evidence-1"],
            }],
          },
        },
      });
    },
  });

  const result = await classifier.classify({
    profileId: "profile-private",
    instrumentId: "SSE:600000",
    theses: [{ id: "thesis-1", text: "收入质量持续改善", status: "active" }],
    factDeltas: [factDelta()],
  }, {});

  assert.equal(requestBody?.task, "market-agent-thesis-impact");
  const serialized = JSON.stringify(requestBody);
  assert.equal(serialized.includes("profile-private"), false);
  assert.equal(serialized.includes("eastmoney"), false);
  assert.equal(serialized.includes("financial.single_quarter.v1"), false);
  assert.equal(serialized.includes("artifact-1"), false);
  assert.deepEqual(result, {
    schemaVersion: "thesis-impact-classifier.v1",
    impacts: [{
      thesisId: "thesis-1",
      impact: "supports",
      explanation: "收入改善可能支持现有论点，但仍需后续报告确认。",
      factDeltaIds: ["delta-1"],
      evidenceIds: ["evidence-1"],
    }],
  });
});

test("thesis classifier rejects oversized Gateway responses without preserving model text", async () => {
  const classifier = new GatewayThesisImpactClassifier({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "gateway-token",
    fetcher: async () => new Response(`{"padding":"${"x".repeat(70_000)}"}`),
  });
  await assert.rejects(
    () => classifier.classify({ profileId: "p1", instrumentId: "SSE:600000", theses: [], factDeltas: [factDelta()] }, {}),
    /THESIS_IMPACT_RESPONSE_TOO_LARGE/,
  );
});

function factDelta(): DossierFactDelta {
  return {
    id: "delta-1",
    kind: "baseline_added",
    logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
    previous: null,
    current: {
      id: "anchor-1",
      logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
      factId: "financial-revenue-q2",
      evidenceId: "evidence-1",
      researchFingerprint: FP,
      instrumentId: "SSE:600000",
      metric: "operating_revenue",
      period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
      value: { decimal: "123", unit: "CNY" },
      formula: { id: "financial.single_quarter.v1", version: "1", expression: "a-b", inputArtifactIds: ["artifact-1"], parameters: {}, rounding: "exact" },
      comparisons: [],
      provenance: { providers: ["eastmoney"], sourceArtifactIds: ["artifact-1"], sourceAsOf: "2026-07-31T08:00:00.000Z", retrievedAt: "2026-08-23T01:00:00.000Z" },
      quality: { status: "operational", reliable: true, coverage: { actual: 1, required: 1 }, warnings: [] },
    },
  };
}
