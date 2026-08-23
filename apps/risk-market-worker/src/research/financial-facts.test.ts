import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialStatementProjection, ResearchArtifact } from "./artifact-store.ts";
import { buildCompanyUpdateFacts } from "./financial-facts.ts";

const SUBJECT = "SSE:600000";

function totalAssetsArtifact(periodEnd: string, value: string): ResearchArtifact {
  const projection: FinancialStatementProjection = {
    statementType: "balance_sheet",
    reportPeriod: {
      start: `${periodEnd.slice(0, 4)}-01-01T00:00:00.000Z`,
      end: periodEnd,
      basis: periodEnd.includes("12-31") ? "fiscal_year" : periodEnd.includes("03-31") ? "quarter" : "year_to_date",
    },
    reportTypeCode: "fixture",
    dataState: "F",
    cells: [{ metric: "total_assets", value, unit: "CNY" }],
  };
  return {
    artifactId: `assets:${periodEnd}`,
    kind: "financial_statement.v1",
    subjectId: SUBJECT,
    logicalKey: `${SUBJECT}:balance:${periodEnd}`,
    sourceAsOf: `${periodEnd.slice(0, 4)}-08-20T00:00:00.000Z`,
    firstObservedAt: "2026-08-23T07:00:00.000Z",
    contentDigest: `sha256:${"0".repeat(64)}`,
    provider: "fixture-financials",
    providerVersion: "fixture-financials.v1",
    retrievedAt: "2026-08-23T07:00:00.000Z",
    payload: projection,
    warnings: [],
    projection,
  };
}

test("total assets remains a point-in-time fact instead of masquerading as a quarter flow", () => {
  const currentEnd = "2026-06-30T00:00:00.000Z";
  const result = buildCompanyUpdateFacts({
    snapshot: {
      observationCutoff: "2026-08-23T07:00:00.000Z",
      knowledgeCutoff: "2026-08-23T07:00:00.000Z",
      artifacts: [
        totalAssetsArtifact("2025-06-30T00:00:00.000Z", "800"),
        totalAssetsArtifact("2026-03-31T00:00:00.000Z", "850"),
        totalAssetsArtifact(currentEnd, "900"),
      ],
    },
    instrumentIds: [SUBJECT],
    retrievedAt: "2026-08-23T07:00:00.000Z",
  });

  const assets = result.facts.find((fact) => fact.metric === "total_assets");
  assert.ok(assets);
  assert.deepEqual(assets.period, { start: currentEnd, end: currentEnd, basis: "point_in_time" });
  assert.ok(assets.comparisons?.every((comparison) => comparison.comparablePeriod.basis === "point_in_time"));
  assert.deepEqual(assets.provenance.sourceArtifactIds, [
    "assets:2025-06-30T00:00:00.000Z",
    "assets:2026-03-31T00:00:00.000Z",
    "assets:2026-06-30T00:00:00.000Z",
  ]);
});
