import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERT_RULE_DRAFT_SCHEMA_VERSION,
  DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
  DOSSIER_PROPOSAL_SCHEMA_VERSION,
  RESEARCH_DOSSIER_REVISION_SCHEMA_VERSION,
  RESEARCH_DOSSIER_PROJECTION_SCHEMA_VERSION,
  RESEARCH_DOSSIER_SCHEMA_VERSION,
  THESIS_IMPACT_CLASSIFIER_SCHEMA_VERSION,
  calculateAlertRuleDraftFingerprint,
  calculateResearchDossierProjectionFingerprint,
  calculateResearchDossierProposalPayloadFingerprint,
  calculateResearchDossierRevisionFingerprint,
  isAlertRuleDraft,
  isDossierBaseReceipt,
  isResearchDossier,
  isResearchDossierProposal,
  isResearchDossierProjection,
  isResearchDossierProjectionResult,
  isResearchDossierRevision,
  validateAlertRuleDraftIntent,
  validateDossierConfirmIntent,
  validateManualThesisProposalIntent,
  validateThesisImpactClassifierOutput,
  verifyAlertRuleDraftFingerprint,
  verifyResearchDossierProjectionFingerprint,
  verifyResearchDossierProposalPayloadFingerprint,
  verifyResearchDossierRevisionFingerprint,
} from "./index.ts";

const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;
const fingerprintC = `sha256:${"c".repeat(64)}` as const;

const emptyBase = {
  schemaVersion: DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
  profileId: "profile-1",
  instrumentId: "SSE:600000",
  dossierId: null,
  revisionId: null,
  dossierVersion: 0,
  dossierFingerprint: null,
};

const currentFact = {
  id: "anchor:revenue:2026q2",
  logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
  factId: "financial:SSE:600000:operating_revenue:2026Q2",
  evidenceId: "evidence-financial-1",
  researchFingerprint: fingerprintA,
  instrumentId: "SSE:600000",
  metric: "operating_revenue",
  period: {
    start: "2026-04-01T00:00:00.000Z",
    end: "2026-06-30T00:00:00.000Z",
    basis: "quarter",
  },
  value: { decimal: "2500000000", unit: "CNY" },
  formula: {
    id: "financial.single_quarter.v1",
    version: "1",
    expression: "current_cumulative - previous_cumulative",
    inputArtifactIds: ["filing:h1", "filing:q1"],
    parameters: { period: "Q2" },
    rounding: "exact-decimal",
  },
  comparisons: [{
    kind: "yoy",
    comparablePeriod: {
      start: "2025-04-01T00:00:00.000Z",
      end: "2025-06-30T00:00:00.000Z",
      basis: "quarter",
    },
    decimal: "0.12",
    unit: "ratio",
    formula: {
      id: "financial.yoy.v1",
      version: "1",
      expression: "current / prior - 1",
      inputArtifactIds: ["filing:h1", "filing:q1", "filing:h1-prior", "filing:q1-prior"],
      parameters: {},
      rounding: "decimal-12-nearest",
    },
  }],
  provenance: {
    providers: ["cninfo", "eastmoney"],
    sourceArtifactIds: ["filing:h1", "filing:q1"],
    sourceAsOf: "2026-08-20T07:00:00.000Z",
    retrievedAt: "2026-08-23T01:00:00.000Z",
  },
  quality: {
    status: "operational",
    reliable: true,
    coverage: { actual: 2, required: 2 },
    warnings: [],
  },
};

function projection() {
  return {
    schemaVersion: RESEARCH_DOSSIER_PROJECTION_SCHEMA_VERSION,
    id: "projection-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    sourceRunId: "run-1",
    sourceEvidenceFingerprint: fingerprintB,
    researchFingerprint: fingerprintA,
    observationCutoff: "2026-08-22T07:00:00.000Z",
    knowledgeCutoff: "2026-08-23T01:00:00.000Z",
    base: emptyBase,
    factDeltas: [{
      id: "delta-1",
      kind: "baseline_added",
      logicalSeriesKey: currentFact.logicalSeriesKey,
      previous: null,
      current: currentFact,
    }],
    thesisImpacts: [],
    quality: { status: "operational", limitations: [] },
    provenance: {
      source: "market-agent-worker",
      factDeltaEngineVersion: "dossier-fact-delta.v1",
      thesisImpactSource: "not_applicable",
    },
    projectedAt: "2026-08-23T01:00:01.000Z",
    fingerprint: fingerprintC,
  };
}

test("DossierBaseReceipt strictly represents either no dossier or one exact revision", () => {
  assert.equal(isDossierBaseReceipt(emptyBase), true);
  assert.equal(isDossierBaseReceipt({
    ...emptyBase,
    dossierId: "dossier-1",
    revisionId: "revision-3",
    dossierVersion: 3,
    dossierFingerprint: fingerprintA,
  }), true);
  assert.equal(isDossierBaseReceipt({ ...emptyBase, revisionId: "revision-1" }), false);
  assert.equal(isDossierBaseReceipt({ ...emptyBase, dossierVersion: 1 }), false);
  assert.equal(isDossierBaseReceipt({ ...emptyBase, provider: "eastmoney" }), false);
});

test("ResearchDossierProjection accepts a strict first baseline and rejects forged or inconsistent fields", () => {
  const value = projection();
  assert.equal(isResearchDossierProjection(value), true);
  assert.equal(isResearchDossierProjection({ ...value, question: "private" }), false);
  assert.equal(isResearchDossierProjection({ ...value, profileId: "another-profile" }), false);
  assert.equal(isResearchDossierProjection({ ...value, instrumentId: "SZSE:000001" }), false);
  assert.equal(isResearchDossierProjection({ ...value, researchFingerprint: fingerprintB }), false);
  assert.equal(isResearchDossierProjection({
    ...value,
    factDeltas: [{ ...value.factDeltas[0], kind: "period_advanced", previous: null }],
  }), false);
  assert.equal(isResearchDossierProjection({
    ...value,
    factDeltas: [{ ...value.factDeltas[0], current: { ...currentFact, quality: { ...currentFact.quality, reliable: false } } }],
  }), false);
});

test("no financial Facts is an explicit not-applicable result and never an empty projection", () => {
  assert.equal(isResearchDossierProjectionResult({ status: "not_applicable", reason: "NO_FINANCIAL_FACTS" }), true);
  assert.equal(isResearchDossierProjectionResult({ status: "not_applicable", reason: "NO_DOSSIER_DELTA" }), true);
  assert.equal(isResearchDossierProjectionResult({ status: "projected", projection: projection() }), true);
  assert.equal(isResearchDossierProjectionResult({ status: "not_applicable", reason: "NO_FINANCIAL_FACTS", proposal: {} }), false);
  assert.equal(isResearchDossierProjection({ ...projection(), factDeltas: [] }), false);
});

test("thesis classifier output can only classify known theses from reliable deltas", () => {
  const context = {
    thesisIds: ["thesis-1"],
    factDeltas: projection().factDeltas,
  };
  const valid = {
    schemaVersion: THESIS_IMPACT_CLASSIFIER_SCHEMA_VERSION,
    impacts: [{
      thesisId: "thesis-1",
      impact: "supports",
      explanation: "营业收入改善可能支持现有论点，但仍需后续报告确认。",
      factDeltaIds: ["delta-1"],
      evidenceIds: ["evidence-financial-1"],
    }],
  };
  assert.deepEqual(validateThesisImpactClassifierOutput(valid, context), []);
  assert.notDeepEqual(validateThesisImpactClassifierOutput({ ...valid, prompt: "private" }, context), []);
  assert.notDeepEqual(validateThesisImpactClassifierOutput({
    ...valid,
    impacts: [{ ...valid.impacts[0], thesisText: "model rewrite" }],
  }, context), []);
  assert.notDeepEqual(validateThesisImpactClassifierOutput({
    ...valid,
    impacts: [{ ...valid.impacts[0], explanation: "收入增长 12% 支持买入。" }],
  }, context), []);
  assert.notDeepEqual(validateThesisImpactClassifierOutput({
    ...valid,
    impacts: [{ ...valid.impacts[0], thesisId: "unknown-thesis" }],
  }, context), []);
});

function revision() {
  return {
    schemaVersion: RESEARCH_DOSSIER_REVISION_SCHEMA_VERSION,
    id: "revision-1",
    dossierId: "dossier-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    revisionNumber: 1,
    previousRevisionId: null,
    previousFingerprint: null,
    sourceProposalId: "proposal-1",
    observationCutoff: "2026-08-22T07:00:00.000Z",
    knowledgeCutoff: "2026-08-23T01:00:00.000Z",
    factAnchors: [currentFact],
    unverifiedObservations: [],
    theses: [],
    createdAt: "2026-08-23T01:01:00.000Z",
    fingerprint: fingerprintC,
  };
}

test("Research Dossier root and append-only revision use strict state contracts", () => {
  const dossier = {
    schemaVersion: RESEARCH_DOSSIER_SCHEMA_VERSION,
    id: "dossier-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    currentRevisionId: "revision-1",
    version: 1,
    currentRevisionFingerprint: fingerprintC,
    createdAt: "2026-08-23T01:01:00.000Z",
    updatedAt: "2026-08-23T01:01:00.000Z",
  };
  assert.equal(isResearchDossier(dossier), true);
  assert.equal(isResearchDossier({ ...dossier, version: 0 }), false);
  assert.equal(isResearchDossier({ ...dossier, currentRevision: revision() }), false);
  assert.equal(isResearchDossierRevision(revision()), true);
  assert.equal(isResearchDossierRevision({ ...revision(), revisionNumber: 2 }), false);
  assert.equal(isResearchDossierRevision({
    ...revision(),
    factAnchors: [{ ...currentFact, quality: { ...currentFact.quality, status: "degraded", reliable: false } }],
  }), false);
});

test("projection and revision fingerprints cover their immutable payloads", async () => {
  const projectionValue = projection();
  projectionValue.fingerprint = await calculateResearchDossierProjectionFingerprint(projectionValue);
  assert.equal(await verifyResearchDossierProjectionFingerprint(projectionValue), true);
  assert.equal(await verifyResearchDossierProjectionFingerprint({ ...projectionValue, sourceRunId: "run-tampered" }), false);

  const revisionValue = revision();
  revisionValue.fingerprint = await calculateResearchDossierRevisionFingerprint(revisionValue);
  assert.equal(await verifyResearchDossierRevisionFingerprint(revisionValue), true);
  assert.equal(await verifyResearchDossierRevisionFingerprint({ ...revisionValue, sourceProposalId: "proposal-tampered" }), false);
});

test("Dossier proposal retains strict ownership and permits payload-free retention tombstones", () => {
  const value = {
    schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION,
    id: "proposal-1",
    kind: "projection",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    dossierId: null,
    base: emptyBase,
    sourceRunId: "run-1",
    payload: projection(),
    payloadFingerprint: fingerprintC,
    status: "pending",
    createdAt: "2026-08-23T01:00:01.000Z",
    updatedAt: "2026-08-23T01:00:01.000Z",
    expiresAt: "2026-09-22T01:00:01.000Z",
  };
  assert.equal(isResearchDossierProposal(value), true);
  assert.equal(isResearchDossierProposal({ ...value, rawModelOutput: "private" }), false);
  assert.equal(isResearchDossierProposal({ ...value, payload: null }), false);
  assert.equal(isResearchDossierProposal({ ...value, status: "expired", payload: null }), true);
  assert.equal(isResearchDossierProposal({ ...value, profileId: "other-profile" }), false);
});

test("proposal payload fingerprint is independently verifiable before state mutation", async () => {
  const payload = { operation: "create", text: "经营质量改善能否持续，是当前研究论点。" } as const;
  const value = {
    schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION,
    id: "proposal-thesis-1",
    kind: "manual_thesis",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    dossierId: null,
    base: emptyBase,
    sourceRunId: null,
    payload,
    payloadFingerprint: await calculateResearchDossierProposalPayloadFingerprint(payload),
    status: "pending",
    createdAt: "2026-08-23T01:00:01.000Z",
    updatedAt: "2026-08-23T01:00:01.000Z",
    expiresAt: "2026-09-22T01:00:01.000Z",
  } as const;
  assert.equal(await verifyResearchDossierProposalPayloadFingerprint(value), true);
  assert.equal(await verifyResearchDossierProposalPayloadFingerprint({
    ...value,
    payload: { ...payload, text: "被篡改的论点" },
  }), false);
});

test("confirmation and manual thesis commands expose only closed user-controlled fields", () => {
  assert.deepEqual(validateDossierConfirmIntent({
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-0001",
  }), []);
  assert.notDeepEqual(validateDossierConfirmIntent({
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-0001",
    factDeltaIds: ["delta-1"],
  }), []);
  assert.deepEqual(validateManualThesisProposalIntent({
    operation: "create",
    expectedDossierVersion: 1,
    text: "经营质量改善能否持续，是当前研究论点。",
    idempotencyKey: "thesis-0001",
  }), []);
  assert.deepEqual(validateManualThesisProposalIntent({
    operation: "retire",
    expectedDossierVersion: 2,
    thesisId: "thesis-1",
    idempotencyKey: "thesis-0002",
  }), []);
  assert.notDeepEqual(validateManualThesisProposalIntent({
    operation: "retire",
    expectedDossierVersion: 2,
    thesisId: "thesis-1",
    text: "not allowed",
    idempotencyKey: "thesis-0002",
  }), []);
  assert.notDeepEqual(validateManualThesisProposalIntent({
    operation: "create",
    expectedDossierVersion: 1,
    text: "买入并加仓",
    idempotencyKey: "thesis-0003",
  }), []);
});

function alertDraft() {
  return {
    schemaVersion: ALERT_RULE_DRAFT_SCHEMA_VERSION,
    id: "alert-draft-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    sourceProposalId: "proposal-1",
    sourceProjectionFingerprint: fingerprintC,
    sourceDeltaId: "delta-1",
    sourceEvidenceIds: ["evidence-financial-1"],
    researchFingerprint: fingerprintA,
    predicate: {
      version: "financial-alert-predicate.v1",
      template: "metric_threshold_crossing",
      metric: "operating_revenue",
      baselinePeriod: currentFact.period,
      field: "yoy",
      operator: "crosses_below",
      threshold: { decimal: "0.1", unit: "ratio" },
    },
    requiresReliableFacts: true,
    status: "draft",
    createdAt: "2026-08-23T01:02:00.000Z",
    expiresAt: "2026-09-22T01:02:00.000Z",
    fingerprint: fingerprintB,
  };
}

test("Alert Rule Draft is inert, finite and derived from one proposal delta", async () => {
  const value = alertDraft();
  assert.equal(isAlertRuleDraft(value), true);
  assert.equal(isAlertRuleDraft({ ...value, status: "active" }), false);
  assert.equal(isAlertRuleDraft({ ...value, action: { trade: "buy" } }), false);
  assert.equal(isAlertRuleDraft({ ...value, requiresReliableFacts: false }), false);
  value.fingerprint = await calculateAlertRuleDraftFingerprint(value);
  assert.equal(await verifyAlertRuleDraftFingerprint(value), true);
  assert.equal(await verifyAlertRuleDraftFingerprint({ ...value, sourceDeltaId: "delta-tampered" }), false);
});

test("Alert Rule Draft intent accepts only two fixed templates and strict decimal thresholds", () => {
  assert.deepEqual(validateAlertRuleDraftIntent({
    template: "new_reporting_period",
    deltaId: "delta-1",
    idempotencyKey: "alert-0001",
  }), []);
  assert.deepEqual(validateAlertRuleDraftIntent({
    template: "metric_threshold_crossing",
    deltaId: "delta-1",
    field: "qoq",
    operator: "crosses_above",
    threshold: "0.15",
    idempotencyKey: "alert-0002",
  }), []);
  assert.notDeepEqual(validateAlertRuleDraftIntent({
    template: "metric_threshold_crossing",
    deltaId: "delta-1",
    field: "value",
    operator: "eval",
    threshold: "price * 2",
    idempotencyKey: "alert-0003",
  }), []);
  assert.notDeepEqual(validateAlertRuleDraftIntent({
    template: "new_reporting_period",
    deltaId: "delta-1",
    provider: "eastmoney",
    idempotencyKey: "alert-0004",
  }), []);
});
