import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialMetricFact } from "@zxlab/research-fact-schema";
import type { ResearchDossierProjectionResult, ResearchDossierRevision } from "@zxlab/market-agent-schema";
import { ResearchDossierProjector, type ResearchDossierProjectionInput } from "./research-dossier-projector.ts";

const NOW = "2026-08-23T03:00:00.000Z";
const FP = `sha256:${"a".repeat(64)}` as const;

test("first reliable financial Fact becomes a pending dossier baseline", async () => {
  const result = await new ResearchDossierProjector().project(input([financialFact()]), {
    mode: "fact_only",
    projectedAt: NOW,
  });

  const projection = mustProject(result);
  assert.equal(projection.factDeltas.length, 1);
  assert.deepEqual(projection.factDeltas[0], {
    id: "fact-delta:SSE:600000:operating_revenue:quarter:2026-06-30:baseline_added",
    kind: "baseline_added",
    logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
    previous: null,
    current: {
      id: "financial:SSE:600000:operating_revenue:2026Q2",
      logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
      factId: financialFact().id,
      evidenceId: "evidence:financial:revenue:q2",
      researchFingerprint: FP,
      instrumentId: "SSE:600000",
      metric: "operating_revenue",
      period: financialFact().period,
      value: financialFact().value,
      comparisons: [],
      provenance: financialFact().provenance,
      quality: financialFact().quality,
    },
  });
  assert.match(projection.fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("an empty financial slice is not applicable and does not invent a proposal", async () => {
  const result = await new ResearchDossierProjector().project(input([]), {
    mode: "enabled",
    projectedAt: NOW,
  });

  assert.deepEqual(result, { status: "not_applicable", reason: "NO_FINANCIAL_FACTS" });
});

test("new periods advance reliable anchors while old and absent facts never remove state", async () => {
  const base = revision(financialFact({
    id: "financial:SSE:600000:operating_revenue:2026Q1",
    period: { start: "2026-01-01T00:00:00.000Z", end: "2026-03-31T00:00:00.000Z", basis: "quarter" },
    value: { decimal: "1000000000", unit: "CNY" },
  }));
  const projected = await new ResearchDossierProjector().project({ ...input([financialFact()]), baseRevision: base }, { mode: "fact_only", projectedAt: NOW });

  assert.equal(mustProject(projected).factDeltas[0]?.kind, "period_advanced");
  assert.equal(mustProject(projected).factDeltas[0]?.previous?.period.end, "2026-03-31T00:00:00.000Z");

  const older = financialFact({ period: { start: "2025-10-01T00:00:00.000Z", end: "2025-12-31T00:00:00.000Z", basis: "quarter" } });
  const ignored = await new ResearchDossierProjector().project({ ...input([older]), baseRevision: base }, { mode: "fact_only", projectedAt: NOW });
  assert.deepEqual(ignored, { status: "not_applicable", reason: "NO_DOSSIER_DELTA" });
});

test("same-period content and quality changes remain distinct deterministic deltas", async () => {
  const baseFact = financialFact();
  const base = revision(baseFact);
  const revised = financialFact({ value: { decimal: "1234500001", unit: "CNY" } });
  const sourceRevision = await new ResearchDossierProjector().project({ ...input([revised]), baseRevision: base }, { mode: "fact_only", projectedAt: NOW });
  assert.equal(mustProject(sourceRevision).factDeltas[0]?.kind, "source_revised");

  const qualityChanged = financialFact({ quality: { ...baseFact.quality, status: "degraded", reliable: false, warnings: ["OFFICIAL_FILING_UNCORROBORATED"] } });
  const degraded = await new ResearchDossierProjector().project({ ...input([qualityChanged]), baseRevision: base }, { mode: "fact_only", projectedAt: NOW });
  assert.equal(mustProject(degraded).factDeltas[0]?.kind, "quality_changed");
  assert.equal(mustProject(degraded).factDeltas[0]?.current.quality.reliable, false);
  assert.deepEqual(mustProject(degraded).factDeltas[0]?.previous, base.factAnchors[0]);
});

test("unreliable facts never reach the thesis classifier", async () => {
  let calls = 0;
  const projector = new ResearchDossierProjector({ classify: async () => { calls += 1; return []; } });
  const unreliable = financialFact({ quality: { status: "degraded", reliable: false, coverage: { actual: 1, required: 2 }, warnings: ["PARTIAL"] } });
  const result = await projector.project({ ...input([unreliable]), baseRevision: revision(financialFact(), [{
    id: "thesis-1", text: "收入质量持续改善", status: "active", revision: 1, assessments: [], createdAt: NOW, updatedAt: NOW,
  }]) }, { mode: "enabled", projectedAt: NOW });

  assert.equal(calls, 0);
  assert.deepEqual(mustProject(result).thesisImpacts, []);
});

test("bounded classifier may assess existing theses using only reliable delta and Evidence refs", async () => {
  const base = revision(financialFact({
    period: { start: "2026-01-01T00:00:00.000Z", end: "2026-03-31T00:00:00.000Z", basis: "quarter" },
  }), [{ id: "thesis-1", text: "收入质量持续改善", status: "active", revision: 1, assessments: [], createdAt: NOW, updatedAt: NOW }]);
  const projector = new ResearchDossierProjector({
    async classify(payload) {
      assert.deepEqual(payload.theses.map((thesis) => thesis.id), ["thesis-1"]);
      assert.equal(payload.factDeltas.length, 1);
      return { schemaVersion: "thesis-impact-classifier.v1", impacts: [{
        thesisId: "thesis-1",
        impact: "supports",
        explanation: "新报告期的可靠事实支持既有论点",
        factDeltaIds: [payload.factDeltas[0]!.id],
        evidenceIds: [payload.factDeltas[0]!.current.evidenceId],
      }] };
    },
  });

  const result = await projector.project({ ...input([financialFact()]), baseRevision: base }, { mode: "enabled", projectedAt: NOW });
  assert.equal(mustProject(result).thesisImpacts[0]?.impact, "supports");
  assert.deepEqual(mustProject(result).quality.limitations, []);
});

test("invalid model output degrades to fact-only without changing deterministic Fact deltas", async () => {
  const base = revision(financialFact({
    period: { start: "2026-01-01T00:00:00.000Z", end: "2026-03-31T00:00:00.000Z", basis: "quarter" },
  }), [{ id: "thesis-1", text: "收入质量持续改善", status: "active", revision: 1, assessments: [], createdAt: NOW, updatedAt: NOW }]);
  const projector = new ResearchDossierProjector({ classify: async () => ({ schemaVersion: "thesis-impact-classifier.v1", impacts: [{
    thesisId: "thesis-1",
    impact: "supports",
    explanation: "收入增长 12% 因此建议买入",
    factDeltaIds: ["made-up"],
    evidenceIds: ["made-up"],
  }] }) });
  const result = await projector.project({ ...input([financialFact()]), baseRevision: base }, { mode: "enabled", projectedAt: NOW });

  assert.equal(mustProject(result).factDeltas.length, 1);
  assert.deepEqual(mustProject(result).thesisImpacts, []);
  assert.deepEqual(mustProject(result).quality.limitations, [{ code: "THESIS_IMPACT_UNAVAILABLE", retryable: true }]);
});

function input(facts: FinancialMetricFact[]): ResearchDossierProjectionInput {
  return {
    runId: "run-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    evidenceFingerprint: FP,
    researchFingerprint: FP,
    observationCutoff: "2026-08-22T07:00:00.000Z",
    knowledgeCutoff: "2026-08-22T08:00:00.000Z",
    financialFacts: facts.map((fact) => ({ fact, evidenceItemId: "evidence:financial:revenue:q2" })),
    baseRevision: null,
  };
}

function financialFact(overrides: Partial<FinancialMetricFact> = {}): FinancialMetricFact {
  return {
    id: "financial:SSE:600000:operating_revenue:2026Q2",
    kind: "financial_metric",
    subjectId: "SSE:600000",
    metric: "operating_revenue",
    period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
    value: { decimal: "1234500000", unit: "CNY" },
    provenance: {
      providers: ["eastmoney"],
      sourceArtifactIds: ["financial-statement:fixture"],
      sourceAsOf: "2026-07-31T08:00:00.000Z",
      retrievedAt: "2026-08-22T08:00:00.000Z",
    },
    quality: { status: "operational", reliable: true, coverage: { actual: 2, required: 2 }, warnings: [] },
    ...overrides,
  };
}

function revision(fact: FinancialMetricFact, theses: ResearchDossierRevision["theses"] = []): ResearchDossierRevision {
  return {
    schemaVersion: "research-dossier-revision.v1",
    id: "dossier-revision-1",
    dossierId: "dossier-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    revisionNumber: 1,
    previousRevisionId: null,
    previousFingerprint: null,
    factAnchors: [{
      id: fact.id,
      logicalSeriesKey: `${fact.subjectId}:${fact.metric}:${fact.period.basis}`,
      factId: fact.id,
      evidenceId: "evidence:old",
      researchFingerprint: FP,
      instrumentId: fact.subjectId,
      metric: fact.metric,
      period: fact.period,
      value: fact.value,
      ...(fact.formula ? { formula: fact.formula } : {}),
      comparisons: fact.comparisons ?? [],
      provenance: fact.provenance,
      quality: fact.quality,
    }],
    unverifiedObservations: [],
    theses,
    sourceProposalId: "proposal-0",
    observationCutoff: "2026-08-01T00:00:00.000Z",
    knowledgeCutoff: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    fingerprint: FP,
  };
}

function mustProject(result: ResearchDossierProjectionResult) {
  assert.equal(result.status, "projected");
  if (result.status !== "projected") throw new Error("projection expected");
  return result.projection;
}
