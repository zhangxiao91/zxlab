import assert from "node:assert/strict";
import test from "node:test";
import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { calculateResearchFactBundleFingerprint, type ResearchFactBundle } from "@zxlab/research-fact-schema";
import { ResearchDossierProjector } from "./research-dossier-projector.ts";
import { MemoryResearchDossierRepository } from "./research-dossier-repository.ts";
import { ResearchDossierRuntime } from "./research-dossier-runtime.ts";

const NOW = "2026-08-24T03:00:00.000Z";

test("runtime captures an empty base, persists one projection, and reuses it without reclassification", async () => {
  const repository = new MemoryResearchDossierRepository();
  let classifierCalls = 0;
  const runtime = new ResearchDossierRuntime({
    repository,
    projector: new ResearchDossierProjector({ classify: async () => { classifierCalls += 1; return { schemaVersion: "thesis-impact-classifier.v1", impacts: [] }; } }),
    mode: "enabled",
    now: () => NOW,
  });
  const research = await researchFixture();
  const evidence = evidenceFixture(research);
  const base = await runtime.captureBase("profile-1", "SSE:600000");

  const first = await runtime.project({ runId: "run-1", profileId: "profile-1", instrumentId: "SSE:600000", evidence, research, base });
  const replay = await runtime.project({ runId: "run-1", profileId: "profile-1", instrumentId: "SSE:600000", evidence, research, base });

  assert.equal(base.dossierVersion, 0);
  assert.equal(first?.proposal.payload?.factDeltas.length, 1);
  assert.equal(replay?.proposal.id, first?.proposal.id);
  assert.equal(classifierCalls, 0, "an empty dossier has no thesis to classify");
});

test("runtime returns no proposal when the sealed company update contains no financial Facts", async () => {
  const repository = new MemoryResearchDossierRepository();
  const runtime = new ResearchDossierRuntime({ repository, projector: new ResearchDossierProjector(), mode: "fact_only", now: () => NOW });
  const research = await researchFixture();
  research.facts = [];
  research.capabilities[0]!.factIds = [];
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  const evidence = evidenceFixture(research);
  const base = await runtime.captureBase("profile-1", "SSE:600000");

  assert.equal(await runtime.project({ runId: "run-empty", profileId: "profile-1", instrumentId: "SSE:600000", evidence, research, base }), null);
  assert.equal(await repository.getProjectionByRun("run-empty", "profile-1"), null);
});

async function researchFixture(): Promise<ResearchFactBundle> {
  const bundle: ResearchFactBundle = {
    schemaVersion: "research-facts.v2",
    planVersion: "company-update.v1",
    purpose: "company_update",
    observationCutoff: "2026-08-23T01:00:00.000Z",
    knowledgeCutoff: "2026-08-23T02:00:00.000Z",
    generatedAt: "2026-08-23T02:00:00.000Z",
    instrumentIds: ["SSE:600000"],
    facts: [{
      id: "financial-revenue-q2",
      kind: "financial_metric",
      subjectId: "SSE:600000",
      metric: "operating_revenue",
      period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
      value: { decimal: "123", unit: "CNY" },
      provenance: { providers: ["eastmoney"], sourceArtifactIds: ["artifact-1"], sourceAsOf: "2026-07-31T08:00:00.000Z", retrievedAt: "2026-08-23T02:00:00.000Z" },
      quality: { status: "operational", reliable: true, coverage: { actual: 1, required: 1 }, warnings: [] },
    }],
    capabilities: [{ id: "fundamentals", required: true, status: "operational", factIds: ["financial-revenue-q2"], asOf: "2026-07-31T08:00:00.000Z", retrievedAt: "2026-08-23T02:00:00.000Z", warnings: [], limitations: [] }],
    fingerprint: `sha256:${"0".repeat(64)}`,
  };
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);
  return bundle;
}

function evidenceFixture(research: ResearchFactBundle): SealedEvidenceBundle {
  return {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "profile-1",
    workflow: "ask",
    watchlistRevision: "watchlist-1",
    instrumentIds: ["SSE:600000"],
    items: research.facts.map((fact, index) => ({ id: `evidence-${index}`, kind: "market_fact", origin: "server-observed", reliable: fact.quality.reliable, value: { type: "research_fact", researchFingerprint: research.fingerprint, planVersion: research.planVersion, purpose: research.purpose, fact } })),
    contextUses: [],
    fingerprint: `sha256:${"b".repeat(64)}`,
    sealedAt: NOW,
    ask: { scope: "news_and_announcements", planVersion: "ask-plan.v1" },
  };
}
