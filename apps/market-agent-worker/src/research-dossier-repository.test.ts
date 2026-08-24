import assert from "node:assert/strict";
import test from "node:test";
import type { FinancialMetricFact } from "@zxlab/research-fact-schema";
import { calculateResearchDossierProjectionFingerprint } from "@zxlab/market-agent-schema";
import { ResearchDossierProjector } from "./research-dossier-projector.ts";
import { D1ResearchDossierRepository, MemoryResearchDossierRepository } from "./research-dossier-repository.ts";

const NOW = "2026-08-24T03:00:00.000Z";
const EXPIRES = "2026-09-23T03:00:00.000Z";
const FP = `sha256:${"a".repeat(64)}` as const;

test("a Run projection is immutable and profile-scoped", async () => {
  const repository = new MemoryResearchDossierRepository();
  const projection = await projected("run-1");
  const first = await repository.saveProjection(projection, EXPIRES);
  const reused = await repository.saveProjection(projection, EXPIRES);

  assert.equal(first.created, true);
  assert.equal(reused.created, false);
  assert.equal((await repository.getProjectionByRun("run-1", "profile-1"))?.id, first.proposal.id);
  assert.equal(await repository.getProjectionByRun("run-1", "profile-other"), null);

  const conflicting = structuredClone(projection);
  conflicting.fingerprint = `sha256:${"b".repeat(64)}`;
  await assert.rejects(repository.saveProjection(conflicting, EXPIRES), /DOSSIER_PROJECTION_INTEGRITY_FAILURE/);
});

test("confirm creates revision one and an idempotent retry cannot overwrite it", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal } = await repository.saveProjection(await projected("run-confirm"), EXPIRES);
  const intent = { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "confirm-run-confirm" };

  const first = await repository.confirm(proposal.id, "profile-1", intent, NOW);
  const retry = await repository.confirm(proposal.id, "profile-1", intent, NOW);

  assert.equal(first.reused, false);
  assert.equal(retry.reused, true);
  assert.equal(first.dossier.version, 1);
  assert.equal(first.revision.revisionNumber, 1);
  assert.equal(first.revision.factAnchors.length, 1);
  assert.equal(first.revision.unverifiedObservations.length, 0);
  assert.deepEqual(retry, { ...first, reused: true });
  assert.deepEqual(await repository.getDossier("profile-1", "SSE:600000"), { dossier: first.dossier, revision: first.revision });
});

test("confirm rejects stale dossier versions and idempotency-key payload reuse", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal } = await repository.saveProjection(await projected("run-conflict"), EXPIRES);
  await assert.rejects(repository.confirm(proposal.id, "profile-1", {
    expectedDossierVersion: 1,
    acceptedThesisImpactIds: [],
    idempotencyKey: "stale-confirm",
  }, NOW), /DOSSIER_REVISION_CONFLICT/);

  await repository.confirm(proposal.id, "profile-1", {
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-key",
  }, NOW);
  await assert.rejects(repository.confirm(proposal.id, "profile-1", {
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: ["unexpected-impact"],
    idempotencyKey: "confirm-key",
  }, NOW), /DOSSIER_IDEMPOTENCY_CONFLICT/);
});

test("manual thesis proposals are inert until confirmed as a new dossier revision", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal: baseline } = await repository.saveProjection(await projected("run-thesis"), EXPIRES);
  await repository.confirm(baseline.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "confirm-baseline" }, NOW);

  const manual = await repository.createManualThesisProposal("profile-1", "SSE:600000", {
    operation: "create",
    expectedDossierVersion: 1,
    text: "收入质量持续改善",
    idempotencyKey: "thesis-create",
  }, "2026-08-24T04:00:00.000Z", "2026-09-23T04:00:00.000Z");
  assert.equal(manual.proposal.kind, "manual_thesis");
  assert.equal((await repository.getDossier("profile-1", "SSE:600000"))?.revision.theses.length, 0);

  const confirmed = await repository.confirm(manual.proposal.id, "profile-1", {
    expectedDossierVersion: 1,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-thesis",
  }, "2026-08-24T04:01:00.000Z");
  assert.equal(confirmed.revision.revisionNumber, 2);
  assert.equal(confirmed.revision.theses[0]?.text, "收入质量持续改善");
});

test("a reliable Fact delta creates an inert alert draft independently of dossier confirmation", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal } = await repository.saveProjection(await projected("run-alert"), EXPIRES);
  assert.equal(proposal.kind, "projection");
  if (proposal.kind !== "projection" || !proposal.payload) throw new Error("projection fixture missing");
  const { draft, reused } = await repository.createAlertRuleDraft(proposal.id, "profile-1", {
    template: "metric_threshold_crossing",
    deltaId: proposal.payload!.factDeltas[0]!.id,
    field: "value",
    operator: "crosses_above",
    threshold: "1300000000",
    idempotencyKey: "alert-revenue",
  }, NOW);

  assert.equal(reused, false);
  assert.equal(draft.status, "draft");
  assert.equal(draft.requiresReliableFacts, true);
  assert.deepEqual(draft.predicate, {
    version: "financial-alert-predicate.v1",
    template: "metric_threshold_crossing",
    metric: "operating_revenue",
    baselinePeriod: financialFact().period,
    field: "value",
    operator: "crosses_above",
    threshold: { decimal: "1300000000", unit: "CNY" },
  });
  assert.equal((await repository.listAlertRuleDrafts("profile-1")).length, 1);
  assert.equal((await repository.getProjectionByRun("run-alert", "profile-1"))?.status, "pending");

  const retry = await repository.createAlertRuleDraft(proposal.id, "profile-1", {
    template: "metric_threshold_crossing",
    deltaId: proposal.payload.factDeltas[0]!.id,
    field: "value",
    operator: "crosses_above",
    threshold: "1300000000",
    idempotencyKey: "alert-revenue",
  }, "2026-08-24T03:05:00.000Z");
  assert.equal(retry.reused, true);
  assert.equal(retry.draft.id, draft.id);
});

test("new-reporting-period alerts require a deterministic period advance", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal: baseline } = await repository.saveProjection(await projected("run-alert-baseline"), EXPIRES);
  if (baseline.kind !== "projection" || !baseline.payload) throw new Error("projection fixture missing");
  await assert.rejects(repository.createAlertRuleDraft(baseline.id, "profile-1", {
    template: "new_reporting_period",
    deltaId: baseline.payload.factDeltas[0]!.id,
    idempotencyKey: "alert-baseline-period",
  }, NOW), /ALERT_DRAFT_TEMPLATE_MISMATCH/);

  const confirmed = await repository.confirm(baseline.id, "profile-1", {
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-alert-baseline",
  }, NOW);
  const advancedProjection = await projectedAgainst(
    "run-alert-advanced",
    confirmed.revision,
    financialFactForPeriod("2026Q3", "2026-07-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z"),
    "2026-11-01T09:00:00.000Z",
  );
  const { proposal: advanced } = await repository.saveProjection(advancedProjection, "2026-12-01T09:00:00.000Z");
  if (advanced.kind !== "projection" || !advanced.payload) throw new Error("projection fixture missing");
  assert.equal(advanced.payload.factDeltas[0]?.kind, "period_advanced");
  const result = await repository.createAlertRuleDraft(advanced.id, "profile-1", {
    template: "new_reporting_period",
    deltaId: advanced.payload.factDeltas[0]!.id,
    idempotencyKey: "alert-advanced-period",
  }, "2026-11-01T09:01:00.000Z");
  assert.equal(result.draft.predicate.template, "new_reporting_period");
});

test("expired and non-pending proposals cannot create alert drafts", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal: expired } = await repository.saveProjection(await projected("run-alert-expired"), EXPIRES);
  if (expired.kind !== "projection" || !expired.payload) throw new Error("projection fixture missing");
  await assert.rejects(repository.createAlertRuleDraft(expired.id, "profile-1", {
    template: "metric_threshold_crossing",
    deltaId: expired.payload.factDeltas[0]!.id,
    field: "value",
    operator: "crosses_above",
    threshold: "1300000000",
    idempotencyKey: "alert-expired-proposal",
  }, EXPIRES), /DOSSIER_PROPOSAL_EXPIRED/);

  const { proposal: confirmed } = await repository.saveProjection(await projected("run-alert-confirmed"), EXPIRES);
  if (confirmed.kind !== "projection" || !confirmed.payload) throw new Error("projection fixture missing");
  await repository.confirm(confirmed.id, "profile-1", {
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-before-alert",
  }, NOW);
  await assert.rejects(repository.createAlertRuleDraft(confirmed.id, "profile-1", {
    template: "metric_threshold_crossing",
    deltaId: confirmed.payload.factDeltas[0]!.id,
    field: "value",
    operator: "crosses_above",
    threshold: "1300000000",
    idempotencyKey: "alert-confirmed-proposal",
  }, "2026-08-24T03:01:00.000Z"), /DOSSIER_PROPOSAL_NOT_PENDING/);
});

test("rebase idempotency ignores regenerated projection time and expiry but remains request-bound", async () => {
  const repository = new MemoryResearchDossierRepository();
  const firstProjection = await projected("run-rebase");
  const first = await repository.saveRebasedProjection(firstProjection, EXPIRES, "rebase-run-rebase");
  const { fingerprint: _fingerprint, ...regeneratedPayload } = firstProjection;
  const regenerated = { ...regeneratedPayload, projectedAt: "2026-08-24T03:05:00.000Z", fingerprint: firstProjection.fingerprint };
  regenerated.fingerprint = await calculateResearchDossierProjectionFingerprint(regenerated);

  const retry = await repository.saveRebasedProjection(regenerated, "2026-09-23T03:05:00.000Z", "rebase-run-rebase");
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.proposal.id, first.proposal.id);
});

test("unreliable Fact deltas cannot create alert drafts", async () => {
  const repository = new MemoryResearchDossierRepository();
  const projection = await new ResearchDossierProjector().project({
    runId: "run-unreliable", profileId: "profile-1", instrumentId: "SSE:600000", evidenceFingerprint: FP, researchFingerprint: FP,
    observationCutoff: "2026-08-22T07:00:00.000Z", knowledgeCutoff: "2026-08-22T08:00:00.000Z",
    financialFacts: [{ fact: { ...financialFact(), quality: { status: "degraded", reliable: false, coverage: { actual: 1, required: 2 }, warnings: ["PARTIAL"] } }, evidenceItemId: "evidence:financial:revenue:q2" }],
    baseRevision: null,
  }, { mode: "fact_only", projectedAt: NOW });
  assert.equal(projection.status, "projected");
  if (projection.status !== "projected") throw new Error("projection fixture missing");
  const { proposal } = await repository.saveProjection(projection.projection, EXPIRES);
  assert.equal(proposal.kind, "projection");
  if (proposal.kind !== "projection" || !proposal.payload) throw new Error("projection fixture missing");
  await assert.rejects(repository.createAlertRuleDraft(proposal.id, "profile-1", {
    template: "metric_threshold_crossing", deltaId: proposal.payload!.factDeltas[0]!.id, field: "value", operator: "crosses_above", threshold: "1300000000", idempotencyKey: "unreliable-alert",
  }, NOW), /ALERT_DRAFT_RELIABLE_FACT_REQUIRED/);
});

test("D1 exact-revision replay lookup is profile-scoped", async () => {
  let sql = "";
  let values: unknown[] = [];
  const db = { prepare(statement: string) { sql = statement; return { bind(...bound: unknown[]) { values = bound; return { async first() { return null; } }; } }; } } as unknown as D1Database;
  const revision = await new D1ResearchDossierRepository(db).getRevision("profile-owner", "revision-1");
  assert.equal(revision, null);
  assert.match(sql, /profile_id = \?/);
  assert.deepEqual(values, ["revision-1", "profile-owner"]);
});

test("retention expires pending proposals and drafts, then privacy purge removes the dossier aggregate", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal } = await repository.saveProjection(await projected("run-retention"), EXPIRES);
  assert.equal(proposal.kind, "projection");
  if (proposal.kind !== "projection" || !proposal.payload) throw new Error("projection fixture missing");
  const alertIntent = { template: "metric_threshold_crossing" as const, deltaId: proposal.payload.factDeltas[0]!.id, field: "value" as const, operator: "crosses_above" as const, threshold: "1300000000", idempotencyKey: "retention-alert" };
  await repository.createAlertRuleDraft(proposal.id, "profile-1", alertIntent, NOW);
  const expired = await repository.sweepRetention("2026-09-24T03:00:00.000Z");
  assert.deepEqual(expired, { expiredProposals: 1, purgedProposalPayloads: 0, expiredAlertDrafts: 1 });
  assert.equal((await repository.getProjectionByRun("run-retention", "profile-1"))?.status, "expired");
  await assert.rejects(repository.confirm(proposal.id, "profile-1", {
    expectedDossierVersion: 0,
    acceptedThesisImpactIds: [],
    idempotencyKey: "confirm-expired",
  }, "2026-09-24T03:01:00.000Z"), /DOSSIER_PROPOSAL_EXPIRED/);
  const purged = await repository.sweepRetention("2026-12-24T03:01:00.000Z");
  assert.equal(purged.purgedProposalPayloads, 1);
  await assert.rejects(
    repository.createAlertRuleDraft(proposal.id, "profile-1", alertIntent, "2026-12-24T03:02:00.000Z"),
    /DOSSIER_PROPOSAL_NOT_FOUND/,
  );

  const { proposal: confirmedProposal } = await repository.saveProjection(await projected("run-purge"), "2026-09-23T03:00:00.000Z");
  await repository.confirm(confirmedProposal.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "purge-confirm" }, NOW);
  assert.deepEqual(await repository.purgeDossier("profile-1", "SSE:600000", { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-dossier-1" }, "2026-08-24T04:00:00.000Z"), { purged: true, reused: false });
  assert.deepEqual(await repository.purgeDossier("profile-1", "SSE:600000", { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-dossier-1" }, "2026-08-24T04:01:00.000Z"), { purged: true, reused: true });
  assert.equal(await repository.getDossier("profile-1", "SSE:600000"), null);
});

test("resource IDs remain globally unique when profiles reuse the same idempotency key", async () => {
  const repository = new MemoryResearchDossierRepository();
  const first = await repository.saveProjection(await projected("run-global-1", "profile-1"), EXPIRES);
  const second = await repository.saveProjection(await projected("run-global-2", "profile-2"), EXPIRES);
  if (first.proposal.kind !== "projection" || !first.proposal.payload || second.proposal.kind !== "projection" || !second.proposal.payload) throw new Error("projection fixture missing");
  const intent = (deltaId: string) => ({ template: "metric_threshold_crossing" as const, deltaId, field: "value" as const, operator: "crosses_above" as const, threshold: "1300000000", idempotencyKey: "same-alert-key" });
  const left = await repository.createAlertRuleDraft(first.proposal.id, "profile-1", intent(first.proposal.payload.factDeltas[0]!.id), NOW);
  const right = await repository.createAlertRuleDraft(second.proposal.id, "profile-2", intent(second.proposal.payload.factDeltas[0]!.id), NOW);
  assert.notEqual(left.draft.id, right.draft.id);
});

test("D1 dismiss fails closed when its pending-status CAS loses", async () => {
  const proposal = (await new MemoryResearchDossierRepository().saveProjection(await projected("run-dismiss-cas"), EXPIRES)).proposal;
  const db = {
    prepare(sql: string) {
      return { bind() { return { async first() {
        if (sql.includes("research_dossier_commands")) return null;
        if (sql.includes("research_dossier_proposals")) return { payload_json: JSON.stringify(proposal) };
        return null;
      } }; } };
    },
    async batch() { return [{ meta: { changes: 0 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]; },
  } as unknown as D1Database;
  await assert.rejects(new D1ResearchDossierRepository(db).dismiss(proposal.id, "profile-1", { idempotencyKey: "dismiss-cas-key" }, NOW), /DOSSIER_PROPOSAL_NOT_PENDING/);
});

test("D1 rebase persists proposal and idempotency command in one atomic batch", async () => {
  const batches: D1PreparedStatement[][] = [];
  let standaloneWrites = 0;
  const db = {
    prepare() { return { bind() { return { async first() { return null; }, async run() { standaloneWrites += 1; return { meta: { changes: 1 } }; } }; } }; },
    async batch(statements: D1PreparedStatement[]) { batches.push(statements); return statements.map(() => ({ meta: { changes: 1 } })); },
  } as unknown as D1Database;
  const projection = await projected("run-atomic-rebase");
  const result = await new D1ResearchDossierRepository(db).saveRebasedProjection(projection, EXPIRES, "atomic-rebase-key");
  assert.equal(result.created, true);
  assert.equal(standaloneWrites, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 2);
});

test("D1 retention clears idempotency result bodies for purged proposal and draft resources", async () => {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) { statements.push(sql); return { bind() { return { async all() { return { results: [] }; }, async run() { return { meta: { changes: 0 } }; } }; } }; },
    async batch() { return []; },
  } as unknown as D1Database;
  await new D1ResearchDossierRepository(db).sweepRetention("2026-12-24T03:00:00.000Z");
  assert.ok(statements.some((sql) => /UPDATE research_dossier_commands SET result_json = NULL/.test(sql)));
});

test("confirm rejects unrelated Thesis impact IDs for projection and manual proposals", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal } = await repository.saveProjection(await projected("run-impact-invalid"), EXPIRES);
  await assert.rejects(repository.confirm(proposal.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: ["not-in-proposal"], idempotencyKey: "impact-invalid-1" }, NOW), /DOSSIER_CONFIRM_INVALID/);
  await repository.confirm(proposal.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "impact-valid-1" }, NOW);
  const manual = await repository.createManualThesisProposal("profile-1", "SSE:600000", { operation: "create", text: "收入质量改善", expectedDossierVersion: 1, idempotencyKey: "manual-impact-create" }, "2026-08-24T04:00:00.000Z", "2026-09-23T04:00:00.000Z");
  await assert.rejects(repository.confirm(manual.proposal.id, "profile-1", { expectedDossierVersion: 1, acceptedThesisImpactIds: ["not-in-manual"], idempotencyKey: "manual-impact-invalid" }, "2026-08-24T04:01:00.000Z"), /DOSSIER_CONFIRM_INVALID/);
});

test("confirm retains only the latest degraded observation per logical series", async () => {
  const repository = new MemoryResearchDossierRepository();
  const q2 = { ...financialFact(), quality: { status: "degraded" as const, reliable: false, coverage: { actual: 1, required: 2 }, warnings: ["PARTIAL"] } };
  const firstResult = await new ResearchDossierProjector().project({ runId: "run-degraded-q2", profileId: "profile-1", instrumentId: "SSE:600000", evidenceFingerprint: FP, researchFingerprint: FP, observationCutoff: "2026-08-22T07:00:00.000Z", knowledgeCutoff: "2026-08-22T08:00:00.000Z", financialFacts: [{ fact: q2, evidenceItemId: "evidence-q2" }], baseRevision: null }, { mode: "fact_only", projectedAt: NOW });
  if (firstResult.status !== "projected") throw new Error("projection fixture missing");
  const first = await repository.saveProjection(firstResult.projection, EXPIRES);
  const baseline = await repository.confirm(first.proposal.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "degraded-q2-confirm" }, NOW);
  const q3 = { ...q2, id: "financial:SSE:600000:operating_revenue:2026Q3", period: { start: "2026-07-01T00:00:00.000Z", end: "2026-09-30T00:00:00.000Z", basis: "quarter" as const }, provenance: { ...q2.provenance, sourceAsOf: "2026-10-31T08:00:00.000Z", retrievedAt: "2026-11-01T08:00:00.000Z" } };
  const secondResult = await new ResearchDossierProjector().project({ runId: "run-degraded-q3", profileId: "profile-1", instrumentId: "SSE:600000", evidenceFingerprint: FP, researchFingerprint: FP, observationCutoff: "2026-11-01T07:00:00.000Z", knowledgeCutoff: "2026-11-01T08:00:00.000Z", financialFacts: [{ fact: q3, evidenceItemId: "evidence-q3" }], baseRevision: baseline.revision }, { mode: "fact_only", projectedAt: "2026-11-01T09:00:00.000Z" });
  if (secondResult.status !== "projected") throw new Error("projection fixture missing");
  const second = await repository.saveProjection(secondResult.projection, "2026-12-01T09:00:00.000Z");
  const updated = await repository.confirm(second.proposal.id, "profile-1", { expectedDossierVersion: 1, acceptedThesisImpactIds: [], idempotencyKey: "degraded-q3-confirm" }, "2026-11-01T09:01:00.000Z");
  assert.equal(updated.revision.unverifiedObservations.length, 1);
  assert.equal(updated.revision.unverifiedObservations[0]?.factId, q3.id);
});

test("D1 exact revision lookup rejects a forged revision fingerprint", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal } = await repository.saveProjection(await projected("run-forged-revision"), EXPIRES);
  const confirmed = await repository.confirm(proposal.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "forged-confirm" }, NOW);
  const forged = { ...confirmed.revision, fingerprint: `sha256:${"f".repeat(64)}` };
  const db = { prepare() { return { bind() { return { async first() { return { payload_json: JSON.stringify(forged) }; } }; } }; } } as unknown as D1Database;
  await assert.rejects(new D1ResearchDossierRepository(db).getRevision("profile-1", forged.id), /DOSSIER_INTEGRITY_FAILURE/);
});

test("Memory getDossier validates every revision in the immutable chain", async () => {
  const repository = new MemoryResearchDossierRepository();
  const { proposal: baseline } = await repository.saveProjection(await projected("run-memory-chain"), EXPIRES);
  const first = await repository.confirm(baseline.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "chain-first" }, NOW);
  const manual = await repository.createManualThesisProposal("profile-1", "SSE:600000", { operation: "create", expectedDossierVersion: 1, text: "收入质量持续改善", idempotencyKey: "chain-thesis" }, "2026-08-24T04:00:00.000Z", "2026-09-23T04:00:00.000Z");
  const second = await repository.confirm(manual.proposal.id, "profile-1", { expectedDossierVersion: 1, acceptedThesisImpactIds: [], idempotencyKey: "chain-second" }, "2026-08-24T04:01:00.000Z");
  const revised = await repository.createManualThesisProposal("profile-1", "SSE:600000", { operation: "revise", thesisId: second.revision.theses[0]!.id, expectedDossierVersion: 2, text: "收入与现金流质量持续改善", idempotencyKey: "chain-thesis-revise" }, "2026-08-24T05:00:00.000Z", "2026-09-23T05:00:00.000Z");
  await repository.confirm(revised.proposal.id, "profile-1", { expectedDossierVersion: 2, acceptedThesisImpactIds: [], idempotencyKey: "chain-third" }, "2026-08-24T05:01:00.000Z");

  const revisions = (repository as unknown as { revisions: Map<string, typeof first.revision> }).revisions;
  revisions.set(first.revision.id, { ...first.revision, fingerprint: `sha256:${"f".repeat(64)}` });
  await assert.rejects(repository.getDossier("profile-1", "SSE:600000"), /DOSSIER_INTEGRITY_FAILURE/);
});

test("D1 getDossier validates every revision and link in the immutable chain", async () => {
  const memory = new MemoryResearchDossierRepository();
  const { proposal: baseline } = await memory.saveProjection(await projected("run-d1-chain"), EXPIRES);
  const first = await memory.confirm(baseline.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "d1-chain-first" }, NOW);
  const manual = await memory.createManualThesisProposal("profile-1", "SSE:600000", { operation: "create", expectedDossierVersion: 1, text: "收入质量持续改善", idempotencyKey: "d1-chain-thesis" }, "2026-08-24T04:00:00.000Z", "2026-09-23T04:00:00.000Z");
  const second = await memory.confirm(manual.proposal.id, "profile-1", { expectedDossierVersion: 1, acceptedThesisImpactIds: [], idempotencyKey: "d1-chain-second" }, "2026-08-24T04:01:00.000Z");
  const revised = await memory.createManualThesisProposal("profile-1", "SSE:600000", { operation: "revise", thesisId: second.revision.theses[0]!.id, expectedDossierVersion: 2, text: "收入与现金流质量持续改善", idempotencyKey: "d1-chain-thesis-revise" }, "2026-08-24T05:00:00.000Z", "2026-09-23T05:00:00.000Z");
  const third = await memory.confirm(revised.proposal.id, "profile-1", { expectedDossierVersion: 2, acceptedThesisImpactIds: [], idempotencyKey: "d1-chain-third" }, "2026-08-24T05:01:00.000Z");
  const stored = new Map([
    [first.revision.id, { ...first.revision, fingerprint: `sha256:${"f".repeat(64)}` }],
    [second.revision.id, second.revision],
    [third.revision.id, third.revision],
  ]);
  const db = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) { return { async first() {
        if (sql.includes("FROM research_dossiers")) return { payload_json: JSON.stringify(third.dossier) };
        if (sql.includes("FROM research_dossier_revisions")) {
          const revision = stored.get(String(values[0]));
          return revision ? { payload_json: JSON.stringify(revision) } : null;
        }
        return null;
      } }; } };
    },
  } as unknown as D1Database;
  await assert.rejects(new D1ResearchDossierRepository(db).getDossier("profile-1", "SSE:600000"), /DOSSIER_INTEGRITY_FAILURE/);
});

async function projected(runId: string, profileId = "profile-1") {
  const result = await new ResearchDossierProjector().project({
    runId,
    profileId,
    instrumentId: "SSE:600000",
    evidenceFingerprint: FP,
    researchFingerprint: FP,
    observationCutoff: "2026-08-22T07:00:00.000Z",
    knowledgeCutoff: "2026-08-22T08:00:00.000Z",
    financialFacts: [{ fact: financialFact(), evidenceItemId: "evidence:financial:revenue:q2" }],
    baseRevision: null,
  }, { mode: "fact_only", projectedAt: NOW });
  assert.equal(result.status, "projected");
  if (result.status !== "projected") throw new Error("projection fixture missing");
  return result.projection;
}

async function projectedAgainst(runId: string, baseRevision: Awaited<ReturnType<MemoryResearchDossierRepository["getRevision"]>> & {}, fact: FinancialMetricFact, projectedAt: string) {
  const result = await new ResearchDossierProjector().project({
    runId,
    profileId: "profile-1",
    instrumentId: "SSE:600000",
    evidenceFingerprint: FP,
    researchFingerprint: FP,
    observationCutoff: fact.provenance.sourceAsOf,
    knowledgeCutoff: fact.provenance.retrievedAt,
    financialFacts: [{ fact, evidenceItemId: `evidence:${fact.id}` }],
    baseRevision,
  }, { mode: "fact_only", projectedAt });
  if (result.status !== "projected") throw new Error("projection fixture missing");
  return result.projection;
}

function financialFactForPeriod(label: string, start: string, end: string): FinancialMetricFact {
  const fact = financialFact();
  return {
    ...fact,
    id: `financial:SSE:600000:operating_revenue:${label}`,
    period: { ...fact.period, start, end },
    provenance: { ...fact.provenance, sourceAsOf: "2026-10-31T08:00:00.000Z", retrievedAt: "2026-11-01T08:00:00.000Z" },
  };
}

function financialFact(): FinancialMetricFact {
  return {
    id: "financial:SSE:600000:operating_revenue:2026Q2",
    kind: "financial_metric",
    subjectId: "SSE:600000",
    metric: "operating_revenue",
    period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
    value: { decimal: "1234500000", unit: "CNY" },
    provenance: { providers: ["eastmoney"], sourceArtifactIds: ["financial-statement:fixture"], sourceAsOf: "2026-07-31T08:00:00.000Z", retrievedAt: "2026-08-22T08:00:00.000Z" },
    quality: { status: "operational", reliable: true, coverage: { actual: 2, required: 2 }, warnings: [] },
  };
}
