import {
  DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
  isDossierBaseReceipt,
  isResearchDossierProposal,
  verifyResearchDossierProjectionFingerprint,
  type DossierBaseReceipt,
  type ResearchDossierProjection,
  type ResearchDossierProposal,
  type ResearchDossierProjectionResult,
  type SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";
import {
  verifyResearchFactBundleFingerprint,
  type FinancialMetricFact,
  type ResearchFactBundle,
} from "@zxlab/research-fact-schema";
import {
  type DossierProjectionMode,
  type ResearchDossierProjector,
  type Sha256Fingerprint,
} from "./research-dossier-projector.ts";
import type { ResearchDossierRepository } from "./research-dossier-repository.ts";

const PROPOSAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type ResearchDossierProjectorMode = "disabled" | DossierProjectionMode;

export interface ResearchDossierRuntimeInput {
  runId: string;
  profileId: string;
  instrumentId: string;
  evidence: SealedEvidenceBundle;
  research: ResearchFactBundle;
  base: DossierBaseReceipt;
}

export type ResearchDossierRebaseInput = Omit<ResearchDossierRuntimeInput, "base"> & { idempotencyKey: string };

export interface ResearchDossierRuntimeControls {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ResearchDossierProjectionSession {
  result: Extract<ResearchDossierProjectionResult, { status: "projected" }>;
  proposal: ResearchDossierProjectionProposal;
  reused: boolean;
}

export type ResearchDossierProjectionProposal = Extract<ResearchDossierProposal, { kind: "projection" }>;

/**
 * Run-owned orchestration seam for point-in-time Dossier projection.
 *
 * Callers capture the base before sealing run-checkpoint.v4, then call project
 * only with the sealed Evidence and Research bundle from that checkpoint.
 */
export class ResearchDossierRuntime {
  constructor(private readonly dependencies: {
    repository: ResearchDossierRepository;
    projector: ResearchDossierProjector;
    mode: ResearchDossierProjectorMode;
    now?: () => string;
  }) {}

  async captureBase(profileId: string, instrumentId: string): Promise<DossierBaseReceipt> {
    assertIdentity(profileId, instrumentId);
    if (this.dependencies.mode === "disabled") throw new Error("DOSSIER_PROJECTOR_DISABLED");
    const current = await this.dependencies.repository.getDossier(profileId, instrumentId);
    const receipt: DossierBaseReceipt = current ? {
      schemaVersion: DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
      profileId,
      instrumentId,
      dossierId: current.dossier.id,
      revisionId: current.revision.id,
      dossierVersion: current.dossier.version,
      dossierFingerprint: current.revision.fingerprint,
    } : {
      schemaVersion: DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
      profileId,
      instrumentId,
      dossierId: null,
      revisionId: null,
      dossierVersion: 0,
      dossierFingerprint: null,
    };
    if (!isDossierBaseReceipt(receipt)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    return receipt;
  }

  async project(input: ResearchDossierRuntimeInput, controls: ResearchDossierRuntimeControls = {}): Promise<ResearchDossierProjectionSession | null> {
    if (this.dependencies.mode === "disabled") return null;
    await assertProjectionInput(input);
    const recovered = await this.dependencies.repository.getProjectionByRun(input.runId, input.profileId);
    if (recovered) return recoveredSession(recovered, input);

    const financialFacts = extractFinancialFacts(input.evidence, input.research, input.instrumentId);
    if (financialFacts.length === 0) return null;
    const baseRevision = input.base.revisionId
      ? await this.dependencies.repository.getRevision(input.profileId, input.base.revisionId)
      : null;
    if (input.base.revisionId && (!baseRevision
      || baseRevision.dossierId !== input.base.dossierId
      || baseRevision.instrumentId !== input.instrumentId
      || baseRevision.fingerprint !== input.base.dossierFingerprint)) throw new Error("DOSSIER_INTEGRITY_FAILURE");

    const projectedAt = this.now();
    const result = await this.dependencies.projector.project({
      runId: input.runId,
      profileId: input.profileId,
      instrumentId: input.instrumentId,
      evidenceFingerprint: input.evidence.fingerprint as Sha256Fingerprint,
      researchFingerprint: input.research.fingerprint,
      observationCutoff: input.research.observationCutoff,
      knowledgeCutoff: input.research.knowledgeCutoff,
      financialFacts,
      baseRevision,
    }, {
      mode: this.dependencies.mode,
      projectedAt,
      ...(controls.signal ? { signal: controls.signal } : {}),
      ...(controls.deadlineAt !== undefined ? { deadlineAt: controls.deadlineAt } : {}),
    });
    if (result.status === "not_applicable") return null;
    assertProjectionMatchesBase(result.projection, input.base);
    const expiresAt = new Date(Date.parse(projectedAt) + PROPOSAL_RETENTION_MS).toISOString();
    const saved = await this.dependencies.repository.saveProjection(result.projection, expiresAt);
    if (saved.proposal.kind !== "projection") throw new Error("DOSSIER_INTEGRITY_FAILURE");
    return { result, proposal: saved.proposal, reused: !saved.created };
  }

  async rebase(input: ResearchDossierRebaseInput, controls: ResearchDossierRuntimeControls = {}): Promise<ResearchDossierProjectionSession | null> {
    if (this.dependencies.mode === "disabled") return null;
    const base = await this.captureBase(input.profileId, input.instrumentId);
    const projectionInput: ResearchDossierRuntimeInput = { ...input, base };
    await assertProjectionInput(projectionInput);
    const financialFacts = extractFinancialFacts(input.evidence, input.research, input.instrumentId);
    if (financialFacts.length === 0) return null;
    const baseRevision = base.revisionId
      ? await this.dependencies.repository.getRevision(input.profileId, base.revisionId)
      : null;
    if (base.revisionId && (!baseRevision
      || baseRevision.dossierId !== base.dossierId
      || baseRevision.instrumentId !== input.instrumentId
      || baseRevision.fingerprint !== base.dossierFingerprint)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    const projectedAt = this.now();
    const result = await this.dependencies.projector.project({
      runId: input.runId,
      profileId: input.profileId,
      instrumentId: input.instrumentId,
      evidenceFingerprint: input.evidence.fingerprint as Sha256Fingerprint,
      researchFingerprint: input.research.fingerprint,
      observationCutoff: input.research.observationCutoff,
      knowledgeCutoff: input.research.knowledgeCutoff,
      financialFacts,
      baseRevision,
    }, {
      mode: this.dependencies.mode,
      projectedAt,
      ...(controls.signal ? { signal: controls.signal } : {}),
      ...(controls.deadlineAt !== undefined ? { deadlineAt: controls.deadlineAt } : {}),
    });
    if (result.status === "not_applicable") return null;
    assertProjectionMatchesBase(result.projection, base);
    const expiresAt = new Date(Date.parse(projectedAt) + PROPOSAL_RETENTION_MS).toISOString();
    const saved = await this.dependencies.repository.saveRebasedProjection(result.projection, expiresAt, input.idempotencyKey);
    if (saved.proposal.kind !== "projection") throw new Error("DOSSIER_INTEGRITY_FAILURE");
    return { result, proposal: saved.proposal, reused: !saved.created };
  }

  private now(): string {
    const value = this.dependencies.now?.() ?? new Date().toISOString();
    if (!isCanonicalIso(value)) throw new Error("DOSSIER_RUNTIME_TIME_INVALID");
    return value;
  }
}

async function assertProjectionInput(input: ResearchDossierRuntimeInput): Promise<void> {
  assertIdentity(input.profileId, input.instrumentId);
  if (!boundedId(input.runId)
    || input.evidence.profileId !== input.profileId
    || input.evidence.workflow !== "ask"
    || input.evidence.ask?.scope !== "news_and_announcements"
    || input.evidence.instrumentIds.length !== 1
    || input.evidence.instrumentIds[0] !== input.instrumentId
    || input.research.purpose !== "company_update"
    || input.research.planVersion !== "company-update.v1"
    || input.research.instrumentIds.length !== 1
    || input.research.instrumentIds[0] !== input.instrumentId
    || !isFingerprint(input.evidence.fingerprint)
    || !isDossierBaseReceipt(input.base)
    || input.base.profileId !== input.profileId
    || input.base.instrumentId !== input.instrumentId
    || !await verifyResearchFactBundleFingerprint(input.research)) throw new Error("DOSSIER_PROJECTION_INPUT_INVALID");
}

function extractFinancialFacts(
  evidence: SealedEvidenceBundle,
  research: ResearchFactBundle,
  instrumentId: string,
): Array<{ fact: FinancialMetricFact; evidenceItemId: string }> {
  const facts = new Map(research.facts.filter((fact): fact is FinancialMetricFact => fact.kind === "financial_metric" && fact.subjectId === instrumentId).map((fact) => [fact.id, fact]));
  const extracted: Array<{ fact: FinancialMetricFact; evidenceItemId: string }> = [];
  const seen = new Set<string>();
  for (const item of evidence.items) {
    if (!isRecord(item.value) || item.value.type !== "research_fact" || !isRecord(item.value.fact)) continue;
    const factId = item.value.fact.id;
    if (typeof factId !== "string" || seen.has(factId)) continue;
    const fact = facts.get(factId);
    if (!fact) continue;
    if (item.value.researchFingerprint !== research.fingerprint
      || item.value.planVersion !== research.planVersion
      || item.value.purpose !== research.purpose
      || stableJson(item.value.fact) !== stableJson(fact)
      || item.reliable !== fact.quality.reliable) throw new Error("DOSSIER_EVIDENCE_INTEGRITY_FAILURE");
    seen.add(factId);
    extracted.push({ fact: structuredClone(fact), evidenceItemId: item.id });
  }
  return extracted;
}

function recoveredSession(proposal: ResearchDossierProposal, input: ResearchDossierRuntimeInput): ResearchDossierProjectionSession {
  if (!isResearchDossierProposal(proposal)
    || proposal.kind !== "projection"
    || !proposal.payload
    || proposal.profileId !== input.profileId
    || proposal.instrumentId !== input.instrumentId
    || proposal.sourceRunId !== input.runId
    || proposal.payload.sourceEvidenceFingerprint !== input.evidence.fingerprint
    || proposal.payload.researchFingerprint !== input.research.fingerprint
    || !sameBase(proposal.base, input.base)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  return {
    result: { status: "projected", projection: structuredClone(proposal.payload) },
    proposal: structuredClone(proposal),
    reused: true,
  };
}

function assertProjectionMatchesBase(projection: ResearchDossierProjection, base: DossierBaseReceipt): void {
  if (!sameBase(projection.base, base)) throw new Error("DOSSIER_REVISION_CONFLICT");
}

function sameBase(left: DossierBaseReceipt, right: DossierBaseReceipt): boolean {
  return left.profileId === right.profileId
    && left.instrumentId === right.instrumentId
    && left.dossierId === right.dossierId
    && left.revisionId === right.revisionId
    && left.dossierVersion === right.dossierVersion
    && left.dossierFingerprint === right.dossierFingerprint;
}

function assertIdentity(profileId: string, instrumentId: string): void {
  if (!boundedId(profileId) || !/^(SSE|SZSE):\d{6}$/.test(instrumentId)) throw new Error("DOSSIER_IDENTITY_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isCanonicalIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function isFingerprint(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}
