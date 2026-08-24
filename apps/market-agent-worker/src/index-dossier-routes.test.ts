import assert from "node:assert/strict";
import test from "node:test";
import type { DossierBaseReceipt, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { calculateResearchFactBundleFingerprint, type FinancialMetricFact, type ResearchFactBundle } from "@zxlab/research-fact-schema";
import { configuredResearchDossierProjectorMode, handleResearchDossierRoute } from "./index.ts";
import { ResearchDossierProjector } from "./research-dossier-projector.ts";
import { MemoryResearchDossierRepository } from "./research-dossier-repository.ts";
import type { DossierProjectionUnavailableReceipt } from "./run-checkpoint.ts";

test("Dossier projector mode is fail-closed and accepts only the three canonical values", () => {
  assert.equal(configuredResearchDossierProjectorMode({} as Env), "disabled");
  assert.equal(configuredResearchDossierProjectorMode({ RESEARCH_DOSSIER_PROJECTOR_MODE: "disabled" } as Env), "disabled");
  assert.equal(configuredResearchDossierProjectorMode({ RESEARCH_DOSSIER_PROJECTOR_MODE: "fact_only" } as Env), "fact_only");
  assert.equal(configuredResearchDossierProjectorMode({ RESEARCH_DOSSIER_PROJECTOR_MODE: "enabled" } as Env), "enabled");
  assert.equal(configuredResearchDossierProjectorMode({ RESEARCH_DOSSIER_PROJECTOR_MODE: "ENABLED" } as Env), "disabled");
});

test("disabled mode serves no Dossier route and performs zero Dossier I/O", async () => {
  let io = 0;
  const repository = new Proxy({}, { get() { return async () => { io += 1; throw new Error("unexpected Dossier I/O"); }; } }) as MemoryResearchDossierRepository;
  const dependencies = {
    repository,
    mode: "disabled" as const,
    runtime: () => { io += 1; throw new Error("unexpected Dossier runtime"); },
    getCheckpoint: async () => { io += 1; throw new Error("unexpected checkpoint I/O"); },
    getRunPayloadAvailability: async () => { io += 1; throw new Error("unexpected Run I/O"); },
  };
  const read = await handleResearchDossierRoute(
    new Request("https://agent.example/runs/run-1/dossier-projection"),
    "/runs/run-1/dossier-projection",
    "profile-1",
    dependencies,
  );
  const write = await handleResearchDossierRoute(
    new Request("https://agent.example/dossiers/SSE%3A600000", { method: "DELETE", body: "{bad json" }),
    "/dossiers/SSE%3A600000",
    "profile-1",
    dependencies,
  );
  assert.equal(read?.status, 404);
  assert.equal(write?.status, 409);
  assert.equal(io, 0);
});

test("Dossier privacy purge requires exact confirmation, is profile-scoped, and removes the aggregate", async () => {
  const repository = new MemoryResearchDossierRepository();
  await seedConfirmedDossier(repository, "run-purge-route");
  const dependencies = routeDependencies(repository, async () => null);
  const send = (profileId: string, body: unknown) => handleResearchDossierRoute(new Request("https://agent.example/dossiers/SSE%3A600000", {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), "/dossiers/SSE%3A600000", profileId, dependencies);

  const extraKey = await send("profile-1", { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-route-fixed", instrumentId: "SSE:600000" });
  assert.equal(extraKey?.status, 400);
  assert.deepEqual(await extraKey?.json(), { error: "DOSSIER_PURGE_INVALID" });
  assert.ok(await repository.getDossier("profile-1", "SSE:600000"));

  const wrongConfirmation = await send("profile-1", { confirmation: "DELETE_DOSSIER", idempotencyKey: "purge-route-fixed" });
  assert.equal(wrongConfirmation?.status, 400);
  assert.deepEqual(await wrongConfirmation?.json(), { error: "DOSSIER_PURGE_INVALID" });
  assert.ok(await repository.getDossier("profile-1", "SSE:600000"));

  const crossProfile = await send("profile-other", { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-route-other" });
  assert.equal(crossProfile?.status, 404);
  assert.ok(await repository.getDossier("profile-1", "SSE:600000"));

  const purged = await send("profile-1", { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-route-fixed" });
  const retry = await send("profile-1", { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: "purge-route-fixed" });
  assert.equal(purged?.status, 200);
  assert.deepEqual(await purged?.json(), { purged: true, reused: false });
  assert.deepEqual(await retry?.json(), { purged: true, reused: true });
  const read = await handleResearchDossierRoute(new Request("https://agent.example/dossiers/SSE%3A600000"), "/dossiers/SSE%3A600000", "profile-1", dependencies);
  assert.deepEqual(await read?.json(), { dossier: null, revision: null, sourceRun: null });
});

test("manual Thesis proposal route returns the exact proposal and created envelope", async () => {
  const repository = new MemoryResearchDossierRepository();
  await seedConfirmedDossier(repository, "run-thesis-route");
  const dependencies = routeDependencies(repository, async () => null);
  const body = { operation: "create", expectedDossierVersion: 1, text: "收入质量持续改善", idempotencyKey: "thesis-route-fixed" };
  const send = () => handleResearchDossierRoute(new Request("https://agent.example/dossiers/SSE%3A600000/thesis-proposals", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), "/dossiers/SSE%3A600000/thesis-proposals", "profile-1", dependencies);

  const first = await send();
  const retry = await send();
  assert.equal(first?.status, 201);
  assert.equal(retry?.status, 200);
  const firstBody = await first?.json() as { proposal: { kind: string }; created: boolean };
  const retryBody = await retry?.json() as { proposal: { id: string }; created: boolean };
  assert.deepEqual(Object.keys(firstBody).sort(), ["created", "proposal"]);
  assert.equal(firstBody.proposal.kind, "manual_thesis");
  assert.equal(firstBody.created, true);
  assert.equal(retryBody.created, false);
  assert.equal(retryBody.proposal.id, (firstBody.proposal as { id?: string }).id);
});

test("Dossier GET routes return exact envelopes and never expose another profile's projection", async () => {
  const repository = new MemoryResearchDossierRepository();
  const projection = await projectionFixture("run-owner", [financialFact("operating_revenue", "123")]);
  const { proposal } = await repository.saveProjection(projection, "2026-09-23T03:00:00.000Z");
  const dependencies = routeDependencies(repository, async () => null);

  const dossierResponse = await handleResearchDossierRoute(new Request("https://agent.example/dossiers/SSE%3A600001"), "/dossiers/SSE%3A600001", "profile-1", dependencies);
  assert.equal(dossierResponse?.status, 200);
  assert.deepEqual(await dossierResponse?.json(), { dossier: null, revision: null, sourceRun: null });

  const owner = await handleResearchDossierRoute(new Request("https://agent.example/runs/run-owner/dossier-projection"), "/runs/run-owner/dossier-projection", "profile-1", dependencies);
  assert.equal(owner?.status, 200);
  assert.deepEqual(await owner?.json(), { result: { status: "projected", projection }, proposal });

  const isolated = await handleResearchDossierRoute(new Request("https://agent.example/runs/run-owner/dossier-projection"), "/runs/run-owner/dossier-projection", "profile-other", dependencies);
  assert.equal(isolated?.status, 404);
  assert.deepEqual(await isolated?.json(), { error: "NOT_FOUND" });
});

test("confirmed projection Dossier exposes only a bounded source Run retention marker", async () => {
  const repository = new MemoryResearchDossierRepository();
  await seedConfirmedDossier(repository, "run-source-retained");
  let availabilityRequest: { profileId: string; runId: string } | null = null;
  const dependencies = routeDependencies(repository, async () => null, async (profileId, runId) => {
    availabilityRequest = { profileId, runId };
    return false;
  });
  const response = await handleResearchDossierRoute(new Request("https://agent.example/dossiers/SSE%3A600000"), "/dossiers/SSE%3A600000", "profile-1", dependencies);
  const body = await response?.json() as { sourceRun: unknown };
  assert.equal(response?.status, 200);
  assert.deepEqual(body.sourceRun, { runId: "run-source-retained", available: false });
  assert.deepEqual(availabilityRequest, { profileId: "profile-1", runId: "run-source-retained" });
});

test("financial v4 unavailability is retryable while legacy and fact-empty Runs are not applicable", async () => {
  const repository = new MemoryResearchDossierRepository();
  const research = await researchFixture([financialFact("operating_revenue", "123")]);
  const evidence = evidenceFixture(research);
  const base = emptyBase();
  let checkpoint: {
    dossierBase?: DossierBaseReceipt;
    dossierProjectionUnavailable?: DossierProjectionUnavailableReceipt;
    evidence: SealedEvidenceBundle;
    research?: ResearchFactBundle;
  } | null = null;
  const dependencies = routeDependencies(repository, async () => checkpoint);
  const request = new Request("https://agent.example/runs/run-missing/dossier-projection");

  const legacy = await handleResearchDossierRoute(request, "/runs/run-missing/dossier-projection", "profile-1", dependencies);
  assert.equal(legacy?.status, 404);

  checkpoint = {
    dossierProjectionUnavailable: { status: "unavailable", code: "DOSSIER_BASE_UNAVAILABLE", retryable: true },
    evidence,
    research,
  };
  const baseUnavailable = await handleResearchDossierRoute(request, "/runs/run-missing/dossier-projection", "profile-1", dependencies);
  assert.equal(baseUnavailable?.status, 503);
  assert.deepEqual(await baseUnavailable?.json(), { error: "DOSSIER_PROJECTION_UNAVAILABLE", retryable: true });

  checkpoint = { dossierBase: base, evidence, research };
  const unavailable = await handleResearchDossierRoute(request, "/runs/run-missing/dossier-projection", "profile-1", dependencies);
  assert.equal(unavailable?.status, 503);
  assert.deepEqual(await unavailable?.json(), { error: "DOSSIER_PROJECTION_UNAVAILABLE", retryable: true });

  const emptyResearch = await researchFixture([]);
  checkpoint = { dossierBase: base, evidence: evidenceFixture(emptyResearch), research: emptyResearch };
  const notApplicable = await handleResearchDossierRoute(request, "/runs/run-missing/dossier-projection", "profile-1", dependencies);
  assert.equal(notApplicable?.status, 404);
});

test("confirm and Alert Draft routes reject non-exact browser payloads before repository mutation", async () => {
  const repository = new MemoryResearchDossierRepository();
  const dependencies = routeDependencies(repository, async () => null);
  const confirm = await handleResearchDossierRoute(new Request("https://agent.example/dossier-proposals/proposal-1/confirm", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: "confirm-valid", profileId: "profile-other" }),
  }), "/dossier-proposals/proposal-1/confirm", "profile-1", dependencies);
  assert.equal(confirm?.status, 400);
  assert.equal((await confirm?.json() as { error: string }).error, "DOSSIER_CONFIRM_INVALID");

  const alert = await handleResearchDossierRoute(new Request("https://agent.example/dossier-proposals/proposal-1/alert-rule-drafts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ template: "metric_threshold_crossing", deltaId: "delta-1", field: "value", operator: "crosses_above", threshold: "1", idempotencyKey: "alert-valid", url: "https://example.com" }),
  }), "/dossier-proposals/proposal-1/alert-rule-drafts", "profile-1", dependencies);
  assert.equal(alert?.status, 400);
  assert.equal((await alert?.json() as { error: string }).error, "ALERT_DRAFT_INTENT_INVALID");
});

test("Dossier mutations reject declared and streamed bodies above 16 KiB before repository I/O", async () => {
  let io = 0;
  const repository = new Proxy({}, { get() { return async () => { io += 1; throw new Error("unexpected repository I/O"); }; } }) as MemoryResearchDossierRepository;
  const dependencies = routeDependencies(repository, async () => null);
  const declared = await handleResearchDossierRoute(new Request("https://agent.example/dossier-proposals/proposal-1/confirm", {
    method: "POST", headers: { "content-type": "application/json", "content-length": "20000" }, body: "{}",
  }), "/dossier-proposals/proposal-1/confirm", "profile-1", dependencies);
  const streamed = await handleResearchDossierRoute(new Request("https://agent.example/dossier-proposals/proposal-1/confirm", {
    method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"padding":"${"x".repeat(17_000)}"}`)); controller.close(); } }), duplex: "half",
  } as RequestInit & { duplex: "half" }), "/dossier-proposals/proposal-1/confirm", "profile-1", dependencies);

  for (const response of [declared, streamed]) {
    assert.equal(response?.status, 413);
    assert.deepEqual(await response?.json(), { error: "DOSSIER_REQUEST_TOO_LARGE" });
  }
  assert.equal(io, 0);
});

test("Alert Draft route truthfully reports idempotent reuse", async () => {
  const repository = new MemoryResearchDossierRepository();
  const projection = await projectionFixture("run-alert-route", [financialFact("operating_revenue", "123")]);
  const { proposal } = await repository.saveProjection(projection, "2026-09-23T03:00:00.000Z");
  const dependencies = routeDependencies(repository, async () => null);
  const input = {
    template: "metric_threshold_crossing",
    deltaId: projection.factDeltas[0]!.id,
    field: "value",
    operator: "crosses_above",
    threshold: "120",
    idempotencyKey: "alert-route-fixed",
  };
  const send = () => handleResearchDossierRoute(new Request(`https://agent.example/dossier-proposals/${proposal.id}/alert-rule-drafts`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }), `/dossier-proposals/${proposal.id}/alert-rule-drafts`, "profile-1", dependencies);

  const first = await send();
  const retry = await send();
  assert.equal(first?.status, 201);
  assert.equal(retry?.status, 200);
  assert.equal((await first?.json() as { reused: boolean }).reused, false);
  assert.equal((await retry?.json() as { reused: boolean }).reused, true);
});

test("rebase receives the complete sealed checkpoint Facts instead of reconstructing only prior deltas", async () => {
  const repository = new MemoryResearchDossierRepository();
  const research = await researchFixture([
    financialFact("operating_revenue", "123"),
    financialFact("operating_profit", "45"),
  ]);
  const evidence = evidenceFixture(research);
  const oldProjection = await projectionFixture("run-rebase", [financialFact("operating_revenue", "123")], evidence.fingerprint, research.fingerprint);
  const { proposal } = await repository.saveProjection(oldProjection, "2026-09-23T03:00:00.000Z");
  if (proposal.kind !== "projection") throw new Error("projection fixture missing");
  let observedFactCount = 0;
  let observedEvidenceCount = 0;
  let observedKey = "";
  const dependencies = {
    repository,
    mode: "fact_only" as const,
    getCheckpoint: async () => ({ dossierBase: emptyBase(), evidence, research }),
    runtime: () => ({
      rebase: async (input: Parameters<import("./research-dossier-runtime.ts").ResearchDossierRuntime["rebase"]>[0]) => {
        observedFactCount = input.research.facts.length;
        observedEvidenceCount = input.evidence.items.filter((item) => (item.value as { type?: unknown }).type === "research_fact").length;
        observedKey = input.idempotencyKey;
        return { result: { status: "projected" as const, projection: oldProjection }, proposal, reused: true };
      },
    }),
    getRunPayloadAvailability: async () => true,
  };
  const response = await handleResearchDossierRoute(new Request("https://agent.example/runs/run-rebase/dossier-projection/rebase", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "rebase-fixed" }),
  }), "/runs/run-rebase/dossier-projection/rebase", "profile-1", dependencies);

  assert.equal(response?.status, 200);
  assert.equal(observedFactCount, 2);
  assert.equal(observedEvidenceCount, 2);
  assert.equal(observedKey, "rebase-fixed");
});

function routeDependencies(
  repository: MemoryResearchDossierRepository,
  getCheckpoint: () => Promise<{
    dossierBase?: DossierBaseReceipt;
    dossierProjectionUnavailable?: DossierProjectionUnavailableReceipt;
    evidence: SealedEvidenceBundle;
    research?: ResearchFactBundle;
  } | null>,
  getRunPayloadAvailability: (profileId: string, runId: string) => Promise<boolean> = async () => true,
) {
  return {
    repository,
    mode: "fact_only" as const,
    runtime: () => { throw new Error("runtime must not be called"); },
    getCheckpoint: async () => getCheckpoint(),
    getRunPayloadAvailability,
    now: () => "2026-08-24T03:00:00.000Z",
  };
}

async function seedConfirmedDossier(repository: MemoryResearchDossierRepository, runId: string): Promise<void> {
  const { proposal } = await repository.saveProjection(await projectionFixture(runId, [financialFact("operating_revenue", "123")]), "2026-09-23T03:00:00.000Z");
  await repository.confirm(proposal.id, "profile-1", { expectedDossierVersion: 0, acceptedThesisImpactIds: [], idempotencyKey: `confirm-${runId}` }, "2026-08-24T03:00:00.000Z");
}

async function projectionFixture(runId: string, facts: FinancialMetricFact[], evidenceFingerprint = `sha256:${"a".repeat(64)}`, researchFingerprint = `sha256:${"b".repeat(64)}`) {
  const result = await new ResearchDossierProjector().project({
    runId, profileId: "profile-1", instrumentId: "SSE:600000",
    evidenceFingerprint: evidenceFingerprint as `sha256:${string}`, researchFingerprint: researchFingerprint as `sha256:${string}`,
    observationCutoff: "2026-08-23T01:00:00.000Z", knowledgeCutoff: "2026-08-23T02:00:00.000Z",
    financialFacts: facts.map((fact, index) => ({ fact, evidenceItemId: `evidence-${index}` })), baseRevision: null,
  }, { mode: "fact_only", projectedAt: "2026-08-24T03:00:00.000Z" });
  assert.equal(result.status, "projected");
  if (result.status !== "projected") throw new Error("projection fixture missing");
  return result.projection;
}

async function researchFixture(facts: FinancialMetricFact[]): Promise<ResearchFactBundle> {
  const bundle: ResearchFactBundle = {
    schemaVersion: "research-facts.v2", planVersion: "company-update.v1", purpose: "company_update",
    observationCutoff: "2026-08-23T01:00:00.000Z", knowledgeCutoff: "2026-08-23T02:00:00.000Z", generatedAt: "2026-08-23T02:00:00.000Z",
    instrumentIds: ["SSE:600000"], facts,
    capabilities: [{ id: "fundamentals", required: true, status: facts.length ? "operational" : "unavailable", factIds: facts.map((fact) => fact.id), asOf: "2026-08-23T01:00:00.000Z", retrievedAt: "2026-08-23T02:00:00.000Z", warnings: [], limitations: [] }],
    fingerprint: `sha256:${"0".repeat(64)}`,
  };
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);
  return bundle;
}

function evidenceFixture(research: ResearchFactBundle): SealedEvidenceBundle {
  return {
    schemaVersion: "market-agent.v1", eventRuleVersion: "market-event.v1", profileId: "profile-1", workflow: "ask", watchlistRevision: "watchlist-1", instrumentIds: ["SSE:600000"],
    items: research.facts.map((fact, index) => ({ id: `evidence-${index}`, kind: "market_fact", origin: "server-observed", reliable: fact.quality.reliable, value: { type: "research_fact", researchFingerprint: research.fingerprint, planVersion: research.planVersion, purpose: research.purpose, fact } })),
    contextUses: [], fingerprint: `sha256:${"c".repeat(64)}`, sealedAt: "2026-08-24T03:00:00.000Z", ask: { scope: "news_and_announcements", planVersion: "ask-plan.v1" },
  };
}

function emptyBase(): DossierBaseReceipt {
  return { schemaVersion: "dossier-base-receipt.v1", profileId: "profile-1", instrumentId: "SSE:600000", dossierId: null, revisionId: null, dossierVersion: 0, dossierFingerprint: null };
}

function financialFact(metric: FinancialMetricFact["metric"], decimal: string): FinancialMetricFact {
  return {
    id: `financial:SSE:600000:${metric}:2026Q2`, kind: "financial_metric", subjectId: "SSE:600000", metric,
    period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" }, value: { decimal, unit: "CNY" },
    provenance: { providers: ["eastmoney"], sourceArtifactIds: [`artifact-${metric}`], sourceAsOf: "2026-07-31T08:00:00.000Z", retrievedAt: "2026-08-23T02:00:00.000Z" },
    quality: { status: "operational", reliable: true, coverage: { actual: 1, required: 1 }, warnings: [] },
  };
}
