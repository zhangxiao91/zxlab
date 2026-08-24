import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchDossierProjection, ResearchDossierProposal } from "@zxlab/market-agent-schema";
import {
  confirmDossierProposal,
  createAlertRuleDraft,
  dismissDossierProposal,
  createManualThesisProposal,
  deleteResearchDossier,
  getAgentRunDossierProjection,
  getAlertRuleDrafts,
  getResearchDossier,
  rebaseAgentRunDossierProjection,
} from "../src/features/market-agent/client.ts";
import {
  DossierProjectionSection,
  DossierInspectorPanel,
  dossierAlertFieldOptions,
  dossierAlertTemplateOptions,
  formatDossierRatio,
  isDossierThresholdDecimal,
  type DossierProjectionView,
} from "../src/features/market-agent/DossierProjection.tsx";
import { nextInspectorSection } from "../src/features/market-agent/AgentToday.tsx";
import { clearDossierMutationKey, dossierMutationKey } from "../src/features/market-agent/dossier-state.ts";

const FP = `sha256:${"a".repeat(64)}` as const;

test("dossier clients use profile-scoped proposal routes and keep alert drafts inert", async (context) => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const projection = projectionFixture();
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(input).endsWith("/dossier-projection")) {
      return Response.json({ result: { status: "projected", projection }, proposal: serverProposalFixture() });
    }
    if (String(input).endsWith("/confirm")) {
      return Response.json({ proposal: serverProposalFixture("confirmed"), dossier: dossierFixture(), revision: revisionFixture(), reused: false });
    }
    if (String(input).endsWith("/dismiss")) {
      return Response.json({ proposal: serverProposalFixture("dismissed"), reused: false });
    }
    return Response.json({
      draft: {
        schemaVersion: "alert-rule-draft.v1",
        id: "alert-draft-1",
        profileId: "profile-1",
        instrumentId: "SSE:600000",
        sourceProposalId: "proposal-1",
        sourceProjectionFingerprint: FP,
        sourceDeltaId: "delta-1",
        sourceEvidenceIds: ["evidence-financial-1"],
        researchFingerprint: FP,
        predicate: { version: "financial-alert-predicate.v1", template: "metric_threshold_crossing", metric: "operating_revenue", baselinePeriod: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" }, field: "yoy", operator: "crosses_above", threshold: { decimal: "0.15", unit: "ratio" } },
        requiresReliableFacts: true,
        status: "draft",
        createdAt: "2026-08-24T03:00:00.000Z",
        expiresAt: "2026-09-22T03:00:00.000Z",
        fingerprint: FP,
      },
      reused: false,
    });
  });

  const loaded = await getAgentRunDossierProjection("run-1");
  await confirmDossierProposal("proposal-1", {
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-fixed",
  });
  await dismissDossierProposal("proposal-1", "dismiss-fixed");
  const alert = await createAlertRuleDraft("proposal-1", {
    deltaId: "delta-1",
    template: "metric_threshold_crossing",
    field: "yoy",
    operator: "crosses_above",
    threshold: "0.15",
    idempotencyKey: "alert-fixed",
  });

  assert.equal(loaded?.projection.id, projection.id);
  assert.equal(alert.draft.status, "draft");
  assert.deepEqual(requests, [
    { url: "/api/private/market-agent/runs/run-1/dossier-projection", method: "GET", body: null },
    { url: "/api/private/market-agent/dossier-proposals/proposal-1/confirm", method: "POST", body: { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "confirm-fixed" } },
    { url: "/api/private/market-agent/dossier-proposals/proposal-1/dismiss", method: "POST", body: { idempotencyKey: "dismiss-fixed" } },
    { url: "/api/private/market-agent/dossier-proposals/proposal-1/alert-rule-drafts", method: "POST", body: { deltaId: "delta-1", template: "metric_threshold_crossing", field: "yoy", operator: "crosses_above", threshold: "0.15", idempotencyKey: "alert-fixed" } },
  ]);
});

test("disabled or historically inapplicable dossier projection stays absent", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json(
    { error: { code: "DOSSIER_PROJECTOR_DISABLED" } },
    { status: 404 },
  ));
  assert.equal(await getAgentRunDossierProjection("run-legacy"), null);
});

test("dossier history, rebase, manual thesis, and alert list clients preserve canonical routes", async (context) => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/dossiers/SSE%3A600000")) return Response.json({ dossier: dossierFixture(), revision: revisionFixture(), sourceRun: { runId: "run-1", available: true } });
    if (url.endsWith("/rebase")) return Response.json({ result: { status: "projected", projection: projectionFixture() }, proposal: serverProposalFixture() });
    if (url.endsWith("/thesis-proposals")) return Response.json({ proposal: manualThesisProposalFixture(), created: true });
    return Response.json({ drafts: [] });
  });

  const dossier = await getResearchDossier("SSE:600000");
  await rebaseAgentRunDossierProjection("run-1", { idempotencyKey: "rebase-fixed" });
  await createManualThesisProposal("SSE:600000", { operation: "create", expectedDossierVersion: 1, text: "收入质量需要持续验证", idempotencyKey: "thesis-fixed" });
  assert.deepEqual(await getAlertRuleDrafts(), []);
  assert.deepEqual(dossier.sourceRun, { runId: "run-1", available: true });
  assert.deepEqual(requests, [
    { url: "/api/private/market-agent/dossiers/SSE%3A600000", method: "GET", body: null },
    { url: "/api/private/market-agent/runs/run-1/dossier-projection/rebase", method: "POST", body: { idempotencyKey: "rebase-fixed" } },
    { url: "/api/private/market-agent/dossiers/SSE%3A600000/thesis-proposals", method: "POST", body: { operation: "create", expectedDossierVersion: 1, text: "收入质量需要持续验证", idempotencyKey: "thesis-fixed" } },
    { url: "/api/private/market-agent/alert-rule-drafts", method: "GET", body: null },
  ]);
});

test("dossier privacy deletion uses an explicit confirmation over the instrument-scoped route", async (context) => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ purged: true, reused: false });
  });

  assert.deepEqual(await deleteResearchDossier("SSE:600000", {
    confirmation: "DELETE_RESEARCH_DOSSIER",
    idempotencyKey: "purge-fixed",
  }), { purged: true, reused: false });
  assert.deepEqual(requests, [{
    url: "/api/private/market-agent/dossiers/SSE%3A600000",
    method: "DELETE",
    body: { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-fixed" },
  }]);
});

test("first dossier baseline is shown after Fact Blocks as a pending long-term record", () => {
  const source = renderToStaticMarkup(createElement(DossierProjectionSection, {
    view: { proposal: proposalFixture(), projection: projectionFixture() },
    loading: false,
    error: null,
    busyAction: null,
    onConfirm: async () => undefined,
    onDismiss: async () => undefined,
    onCreateAlertDraft: async () => undefined,
    onEvidence: () => undefined,
  }));

  assert.match(source, /本次研究档案变化/);
  assert.match(source, /首次研究基线/);
  assert.match(source, /营业收入/);
  assert.match(source, /1,234,500,000/);
  assert.match(source, /确认更新档案/);
  assert.match(source, /转为 Alert 草案/);
  assert.match(source, /不会激活提醒/);
  assert.match(source, /独立于 Run 保留期/);
});

test("degraded-only dossier facts can be confirmed as unverified observations but cannot become Alert drafts", () => {
  const projection = projectionFixture();
  const degraded: ResearchDossierProjection = {
    ...projection,
    factDeltas: projection.factDeltas.map((delta) => ({
      ...delta,
      current: {
        ...delta.current,
        quality: {
          ...delta.current.quality,
          status: "degraded",
          reliable: false,
          warnings: ["OFFICIAL_FILING_UNCORROBORATED"],
        },
      },
    })),
    quality: {
      status: "degraded",
      limitations: [{ code: "OFFICIAL_FILING_UNCORROBORATED", retryable: true }],
    },
  };
  const source = renderToStaticMarkup(createElement(DossierProjectionSection, {
    view: { proposal: proposalFixture(), projection: degraded },
    loading: false,
    error: null,
    busyAction: null,
    onConfirm: async () => undefined,
    onDismiss: async () => undefined,
    onCreateAlertDraft: async () => undefined,
    onEvidence: () => undefined,
  }));

  assert.match(source, /未验证观察/);
  assert.match(source, /不会覆盖既有可靠锚点/);
  assert.doesNotMatch(source, /disabled=""[^>]*>确认更新档案/);
  assert.match(source, /disabled=""[^>]*>转为 Alert 草案/);
});

test("financial ratio display shifts decimal strings without Number arithmetic", () => {
  assert.equal(formatDossierRatio("0.123456789012345678"), "12.3456789012345678%");
  assert.equal(formatDossierRatio("-0.001"), "-0.1%");
  assert.equal(formatDossierRatio("12"), "1200%");
});

test("alert thresholds follow the shared strict fixed-decimal boundary", () => {
  assert.equal(isDossierThresholdDecimal("0.123456789012345678"), true);
  assert.equal(isDossierThresholdDecimal("-0"), false);
  assert.equal(isDossierThresholdDecimal("1e3"), false);
  assert.equal(isDossierThresholdDecimal("0.1234567890123456789"), false);
});

test("Alert Draft options are constrained by delta semantics and sealed comparisons", () => {
  const baseline = projectionFixture().factDeltas[0]!;
  const periodAdvanced = { ...baseline, kind: "period_advanced" as const };
  const sourceRevised = { ...baseline, kind: "source_revised" as const };
  const qualityChanged = { ...baseline, kind: "quality_changed" as const };

  assert.deepEqual(dossierAlertTemplateOptions(baseline), ["metric_threshold_crossing"]);
  assert.deepEqual(dossierAlertTemplateOptions(sourceRevised), ["metric_threshold_crossing"]);
  assert.deepEqual(dossierAlertTemplateOptions(qualityChanged), ["metric_threshold_crossing"]);
  assert.deepEqual(dossierAlertTemplateOptions(periodAdvanced), ["new_reporting_period", "metric_threshold_crossing"]);
  assert.deepEqual(dossierAlertFieldOptions(baseline.current), ["value"]);

  const withYoY = {
    ...baseline.current,
    comparisons: [{
      kind: "yoy" as const,
      comparablePeriod: { start: "2025-04-01T00:00:00.000Z", end: "2025-06-30T00:00:00.000Z", basis: "quarter" as const },
      decimal: "0.12",
      unit: "ratio" as const,
      formula: { id: "financial.yoy.v1", version: "1", expression: "current / prior - 1", inputArtifactIds: ["artifact-prior"], parameters: {}, rounding: "exact-decimal" },
    }],
  };
  const withYoYAndQoQ = {
    ...withYoY,
    comparisons: [...withYoY.comparisons, {
      kind: "qoq" as const,
      comparablePeriod: { start: "2026-01-01T00:00:00.000Z", end: "2026-03-31T00:00:00.000Z", basis: "quarter" as const },
      decimal: "0.03",
      unit: "ratio" as const,
      formula: { id: "financial.qoq.v1", version: "1", expression: "current / prior - 1", inputArtifactIds: ["artifact-q1"], parameters: {}, rounding: "exact-decimal" },
    }],
  };
  assert.deepEqual(dossierAlertFieldOptions(withYoY), ["value", "yoy"]);
  assert.deepEqual(dossierAlertFieldOptions(withYoYAndQoQ), ["value", "yoy", "qoq"]);
});

test("dossier mutation keys remain stable across transport retries and clear after terminal success", () => {
  const keys = new Map<string, string>();
  let sequence = 0;
  const create = () => `fixed-${++sequence}`;
  assert.equal(dossierMutationKey(keys, "proposal-1", "confirm:", create), "dossier:proposal-1:fixed-1");
  assert.equal(dossierMutationKey(keys, "proposal-1", "confirm:", create), "dossier:proposal-1:fixed-1");
  assert.equal(dossierMutationKey(keys, "proposal-1", "alert:delta-1:0.15", create), "dossier:proposal-1:fixed-2");
  clearDossierMutationKey(keys, "proposal-1", "confirm:");
  assert.equal(dossierMutationKey(keys, "proposal-1", "confirm:", create), "dossier:proposal-1:fixed-3");
});

test("Inspector adds a keyboard-reachable Dossier tab with revision, cutoff, formula, and provenance", () => {
  assert.equal(nextInspectorSection("evidence", "ArrowRight"), "dossier");
  assert.equal(nextInspectorSection("dossier", "ArrowRight"), "outcome");
  const source = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: { proposal: proposalFixture(), projection: projectionFixture() },
    loading: false,
    error: null,
  }));
  for (const expected of ["Base revision", "Observation cutoff", "Evidence fingerprint", "Formula", "financial.single_quarter.v1@1", "Providers", "Source artifacts"]) {
    assert.match(source, new RegExp(expected));
  }
});

test("established Dossier exposes user-authored thesis proposals and inert Alert drafts", () => {
  const source = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: { proposal: { ...proposalFixture(), status: "confirmed" }, projection: projectionFixture() },
    loading: false,
    error: null,
    dossier: dossierFixture(),
    revision: {
      ...revisionFixture(),
      theses: [{ id: "thesis-1", text: "收入增长必须伴随经营现金流改善", status: "active", revision: 1, assessments: [], createdAt: "2026-08-24T03:00:00.000Z", updatedAt: "2026-08-24T03:00:00.000Z" }],
    },
    alertDrafts: [alertDraftFixture()],
    alertDraftsLoading: false,
    alertDraftsError: null,
    busyAction: null,
    onCreateThesisProposal: async () => manualThesisProposalFixture(),
    onConfirmThesisProposal: async () => undefined,
  }));
  for (const expected of ["用户 Thesis", "收入增长必须伴随经营现金流改善", "修订", "标记失效", "退休", "新建 Thesis", "Alert Rule Drafts", "尚未激活", "2026-09-22"]) {
    assert.match(source, new RegExp(expected));
  }
});

test("Inspector keeps confirmed long-term Dossier state visible when the current Run has no projection", () => {
  const source = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: null,
    loading: false,
    error: null,
    dossier: dossierFixture(),
    revision: {
      ...revisionFixture(),
      theses: [{ id: "thesis-1", text: "收入增长必须伴随经营现金流改善", status: "active", revision: 1, assessments: [], createdAt: "2026-08-24T03:00:00.000Z", updatedAt: "2026-08-24T03:00:00.000Z" }],
    },
    alertDrafts: [alertDraftFixture()],
  }));

  for (const expected of [
    "这条 Run 没有 Dossier projection",
    "已确认长期档案",
    "revision-1",
    "收入增长必须伴随经营现金流改善",
    "Alert Rule Drafts",
    "独立于 Run 保留",
  ]) assert.match(source, new RegExp(expected));
});

test("Inspector audits confirmed anchors and unverified observations without requiring the current Run projection", () => {
  const confirmed = projectionFixture().factDeltas[0]!.current;
  const unverified = {
    ...confirmed,
    id: "anchor-unverified-1",
    factId: "financial:SSE:600000:operating_profit:2026Q2",
    evidenceId: "evidence-unverified-1",
    researchFingerprint: `sha256:${"b".repeat(64)}` as const,
    metric: "operating_profit" as const,
    value: { decimal: "987654321", unit: "CNY" as const },
    formula: null,
    provenance: {
      providers: ["cninfo"],
      sourceArtifactIds: ["artifact-unverified-1"],
      sourceAsOf: "2026-08-01T08:00:00.000Z",
      retrievedAt: "2026-08-24T01:00:00.000Z",
    },
    quality: {
      status: "degraded" as const,
      reliable: false,
      coverage: { actual: 1, required: 2 },
      warnings: ["OFFICIAL_FILING_UNCORROBORATED"],
    },
  };
  const source = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: null,
    loading: false,
    error: null,
    dossier: dossierFixture(),
    revision: {
      ...revisionFixture(),
      factAnchors: [confirmed],
      unverifiedObservations: [unverified],
    },
  }));

  for (const expected of [
    "Confirmed Fact Anchors",
    "营业收入",
    "1,234,500,000",
    "2026-04-01 — 2026-06-30",
    "financial.single_quarter.v1@1",
    "evidence-financial-1",
    "eastmoney",
    "artifact-1",
    "2026-07-31T08:00:00.000Z",
    FP,
    "operational · reliable",
    "Unverified observations",
    "营业利润",
    "987,654,321",
    "来源原值",
    "evidence-unverified-1",
    "cninfo",
    "artifact-unverified-1",
    "2026-08-01T08:00:00.000Z",
    `sha256:${"b".repeat(64)}`,
    "degraded · unverified",
    "OFFICIAL_FILING_UNCORROBORATED",
  ]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Inspector marks a retained Dossier when its source Run is no longer available", () => {
  const source = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: null,
    loading: false,
    error: null,
    dossier: dossierFixture(),
    revision: revisionFixture(),
    sourceRun: { runId: "run-1", available: false },
  }));

  assert.match(source, /run-1 · 已清理/);
  assert.match(source, /来源 Run 已清理/);
  assert.match(source, /原 Run 正文与 Evidence 已不可用/);
  assert.match(source, /Dossier revision 仍独立保留/);
});

test("Inspector exposes a separate two-step privacy deletion control", () => {
  const initial = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: null,
    loading: false,
    error: null,
    dossier: dossierFixture(),
    revision: revisionFixture(),
    purgeConfirmationOpen: false,
    onRequestPurge: () => undefined,
    onCancelPurge: () => undefined,
    onConfirmPurge: async () => undefined,
  }));
  assert.match(initial, /删除长期研究档案/);
  assert.doesNotMatch(initial, /确认永久删除/);

  const confirmation = renderToStaticMarkup(createElement(DossierInspectorPanel, {
    view: null,
    loading: false,
    error: null,
    dossier: dossierFixture(),
    revision: revisionFixture(),
    purgeConfirmationOpen: true,
    onRequestPurge: () => undefined,
    onCancelPurge: () => undefined,
    onConfirmPurge: async () => undefined,
  }));
  assert.match(confirmation, /确认永久删除/);
  assert.match(confirmation, /不可恢复/);
  assert.match(confirmation, /级联删除 revisions、proposals 与 Alert drafts/);
});

test("revision conflict exposes explicit rebase instead of silently rebasing", () => {
  const source = renderToStaticMarkup(createElement(DossierProjectionSection, {
    view: { proposal: proposalFixture(), projection: projectionFixture() },
    loading: false,
    error: "Dossier 已有更新，请基于最新 revision 重新投影。",
    revisionConflict: true,
    busyAction: null,
    onConfirm: async () => undefined,
    onDismiss: async () => undefined,
    onRebase: async () => undefined,
    onCreateAlertDraft: async () => alertDraftFixture(),
    onEvidence: () => undefined,
  }));
  assert.match(source, /DOSSIER_REVISION_CONFLICT/);
  assert.match(source, /基于最新 revision 重新投影/);
});

function proposalFixture(): DossierProjectionView["proposal"] {
  return {
    id: "proposal-1",
    status: "pending",
    expiresAt: "2026-09-22T03:00:00.000Z",
  };
}

function serverProposalFixture(status: ResearchDossierProposal["status"] = "pending"): ResearchDossierProposal {
  return {
    schemaVersion: "dossier-proposal.v1",
    id: "proposal-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    dossierId: null,
    base: projectionFixture().base,
    status,
    kind: "projection",
    sourceRunId: "run-1",
    payload: status === "dismissed" || status === "expired" || status === "stale" ? null : projectionFixture(),
    payloadFingerprint: FP,
    createdAt: "2026-08-24T03:00:00.000Z",
    updatedAt: "2026-08-24T03:00:00.000Z",
    expiresAt: "2026-09-22T03:00:00.000Z",
  };
}

function manualThesisProposalFixture(): ResearchDossierProposal {
  const dossier = dossierFixture();
  return {
    schemaVersion: "dossier-proposal.v1",
    id: "proposal-thesis-1",
    kind: "manual_thesis",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    dossierId: dossier.id,
    base: {
      schemaVersion: "dossier-base-receipt.v1",
      profileId: "profile-1",
      instrumentId: "SSE:600000",
      dossierId: dossier.id,
      revisionId: dossier.currentRevisionId,
      dossierVersion: dossier.version,
      dossierFingerprint: dossier.currentRevisionFingerprint,
    },
    sourceRunId: null,
    payload: { operation: "create", text: "收入质量需要持续验证" },
    payloadFingerprint: FP,
    status: "pending",
    createdAt: "2026-08-24T03:00:00.000Z",
    updatedAt: "2026-08-24T03:00:00.000Z",
    expiresAt: "2026-09-22T03:00:00.000Z",
  };
}

function dossierFixture() {
  return {
    schemaVersion: "research-dossier.v1",
    id: "dossier-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    currentRevisionId: "revision-1",
    version: 1,
    currentRevisionFingerprint: FP,
    createdAt: "2026-08-24T03:00:00.000Z",
    updatedAt: "2026-08-24T03:00:00.000Z",
  };
}

function revisionFixture() {
  const projection = projectionFixture();
  return {
    schemaVersion: "research-dossier-revision.v1",
    id: "revision-1",
    dossierId: "dossier-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    revisionNumber: 1,
    previousRevisionId: null,
    previousFingerprint: null,
    sourceProposalId: "proposal-1",
    observationCutoff: projection.observationCutoff,
    knowledgeCutoff: projection.knowledgeCutoff,
    factAnchors: projection.factDeltas.map((delta) => delta.current),
    unverifiedObservations: [],
    theses: [],
    createdAt: "2026-08-24T03:00:00.000Z",
    fingerprint: FP,
  };
}

function alertDraftFixture() {
  return {
    schemaVersion: "alert-rule-draft.v1" as const,
    id: "alert-draft-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    sourceProposalId: "proposal-1",
    sourceProjectionFingerprint: FP,
    sourceDeltaId: "delta-1",
    sourceEvidenceIds: ["evidence-financial-1"],
    researchFingerprint: FP,
    predicate: { version: "financial-alert-predicate.v1" as const, template: "new_reporting_period" as const, metric: "operating_revenue" as const, baselinePeriod: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" as const } },
    requiresReliableFacts: true as const,
    status: "draft" as const,
    createdAt: "2026-08-24T03:00:00.000Z",
    expiresAt: "2026-09-22T03:00:00.000Z",
    fingerprint: FP,
  };
}

function projectionFixture(): ResearchDossierProjection {
  return {
    schemaVersion: "research-dossier-projection.v1",
    id: "projection-1",
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    sourceRunId: "run-1",
    sourceEvidenceFingerprint: FP,
    researchFingerprint: FP,
    observationCutoff: "2026-08-22T07:00:00.000Z",
    knowledgeCutoff: "2026-08-23T01:00:00.000Z",
    base: {
      schemaVersion: "dossier-base-receipt.v1",
      profileId: "profile-1",
      instrumentId: "SSE:600000",
      dossierId: null,
      revisionId: null,
      dossierVersion: 0,
      dossierFingerprint: null,
    },
    factDeltas: [{
      id: "delta-1",
      kind: "baseline_added",
      logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
      previous: null,
      current: {
        id: "anchor-1",
        logicalSeriesKey: "SSE:600000:operating_revenue:quarter",
        factId: "financial:SSE:600000:operating_revenue:2026Q2",
        evidenceId: "evidence-financial-1",
        researchFingerprint: FP,
        instrumentId: "SSE:600000",
        metric: "operating_revenue",
        period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
        value: { decimal: "1234500000", unit: "CNY" },
        formula: { id: "financial.single_quarter.v1", version: "1", expression: "current_cumulative - previous_cumulative", inputArtifactIds: ["artifact-1", "artifact-0"], parameters: { period: "Q2" }, rounding: "exact-decimal" },
        comparisons: [],
        provenance: { providers: ["eastmoney"], sourceArtifactIds: ["artifact-1"], sourceAsOf: "2026-07-31T08:00:00.000Z", retrievedAt: "2026-08-23T01:00:00.000Z" },
        quality: { status: "operational", reliable: true, coverage: { actual: 2, required: 2 }, warnings: [] },
      },
    }],
    thesisImpacts: [],
    quality: { status: "operational", limitations: [] },
    provenance: { source: "market-agent-worker", factDeltaEngineVersion: "dossier-fact-delta.v1", thesisImpactSource: "not_applicable" },
    projectedAt: "2026-08-23T03:00:00.000Z",
    fingerprint: FP,
  };
}
