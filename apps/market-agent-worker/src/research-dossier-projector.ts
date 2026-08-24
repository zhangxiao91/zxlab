import {
  DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
  DOSSIER_FACT_DELTA_ENGINE_VERSION,
  RESEARCH_DOSSIER_PROJECTION_SCHEMA_VERSION,
  THESIS_IMPACT_CLASSIFIER_SCHEMA_VERSION,
  calculateResearchDossierProjectionFingerprint,
  isResearchDossierProjection,
  validateThesisImpactClassifierOutput,
  type DossierBaseReceipt,
  type DossierFactAnchor,
  type DossierFactDelta,
  type DossierProjectionLimitation,
  type ResearchDossierProjection,
  type ResearchDossierProjectionResult,
  type ResearchDossierRevision,
  type ThesisImpactClassifierOutput,
  type ThesisImpact,
  type ThesisStatement,
} from "@zxlab/market-agent-schema";
import type { FinancialMetricFact } from "@zxlab/research-fact-schema";

export type DossierProjectionMode = "fact_only" | "enabled";
export type Sha256Fingerprint = `sha256:${string}`;

export interface ResearchDossierProjectionInput {
  runId: string;
  profileId: string;
  instrumentId: string;
  evidenceFingerprint: Sha256Fingerprint;
  researchFingerprint: Sha256Fingerprint;
  observationCutoff: string;
  knowledgeCutoff: string;
  financialFacts: Array<{ fact: FinancialMetricFact; evidenceItemId: string }>;
  baseRevision: ResearchDossierRevision | null;
}

export interface DossierProjectionControls {
  mode: DossierProjectionMode;
  projectedAt: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface ThesisImpactClassifier {
  classify(input: { profileId: string; instrumentId: string; theses: ThesisStatement[]; factDeltas: DossierFactDelta[] }, controls: { signal?: AbortSignal; deadlineAt?: number }): Promise<unknown>;
}

/** Pure dossier projection seam. `null` means no proposal may be persisted. */
export class ResearchDossierProjector {
  constructor(private readonly classifier?: ThesisImpactClassifier) {}

  async project(input: ResearchDossierProjectionInput, controls: DossierProjectionControls): Promise<ResearchDossierProjectionResult> {
    assertInput(input, controls);
    if (input.financialFacts.length === 0) return { status: "not_applicable", reason: "NO_FINANCIAL_FACTS" };
    const factDeltas = projectFactDeltas(input);
    if (factDeltas.length === 0) return { status: "not_applicable", reason: "NO_DOSSIER_DELTA" };

    const limitations: DossierProjectionLimitation[] = [];
    if (factDeltas.some((delta) => !delta.current.quality.reliable)) limitations.push({ code: "UNRELIABLE_FACT_OBSERVATION", retryable: false });
    let thesisImpacts: ThesisImpact[] = [];
    let thesisImpactSource: ResearchDossierProjection["provenance"]["thesisImpactSource"] = "not_applicable";
    const activeTheses = input.baseRevision?.theses.filter((thesis) => thesis.status === "active") ?? [];
    const reliableDeltas = factDeltas.filter((delta) => delta.current.quality.reliable);
    if (controls.mode === "enabled" && activeTheses.length > 0 && reliableDeltas.length > 0) {
      try {
        if (!this.classifier) throw new Error("THESIS_IMPACT_CLASSIFIER_UNAVAILABLE");
        thesisImpacts = parseThesisImpacts(await this.classifier.classify({ profileId: input.profileId, instrumentId: input.instrumentId, theses: activeTheses, factDeltas: reliableDeltas }, { signal: controls.signal, deadlineAt: controls.deadlineAt }), activeTheses, reliableDeltas);
        thesisImpactSource = thesisImpacts.length > 0 ? "model" : "not_applicable";
      } catch {
        thesisImpactSource = "unavailable";
        limitations.push({ code: "THESIS_IMPACT_UNAVAILABLE", retryable: true });
      }
    }

    const unsigned: Omit<ResearchDossierProjection, "fingerprint"> = {
      schemaVersion: RESEARCH_DOSSIER_PROJECTION_SCHEMA_VERSION,
      id: boundedDerivedId("dossier-projection", input.runId),
      profileId: input.profileId,
      instrumentId: input.instrumentId,
      sourceRunId: input.runId,
      sourceEvidenceFingerprint: input.evidenceFingerprint,
      researchFingerprint: input.researchFingerprint,
      observationCutoff: input.observationCutoff,
      knowledgeCutoff: input.knowledgeCutoff,
      base: dossierBase(input),
      factDeltas,
      thesisImpacts,
      quality: { status: limitations.length > 0 ? "degraded" : "operational", limitations },
      provenance: thesisImpactSource === "model"
        ? { source: "market-agent-worker", factDeltaEngineVersion: DOSSIER_FACT_DELTA_ENGINE_VERSION, thesisImpactSource, thesisClassifierTask: "market-agent-thesis-impact" }
        : { source: "market-agent-worker", factDeltaEngineVersion: DOSSIER_FACT_DELTA_ENGINE_VERSION, thesisImpactSource },
      projectedAt: controls.projectedAt,
    };
    const projection: ResearchDossierProjection = { ...unsigned, fingerprint: await calculateResearchDossierProjectionFingerprint(unsigned) };
    if (!isResearchDossierProjection(projection)) throw new Error("DOSSIER_PROJECTION_INTEGRITY_FAILURE");
    return { status: "projected", projection };
  }
}

function projectFactDeltas(input: ResearchDossierProjectionInput): DossierFactDelta[] {
  const anchors = new Map((input.baseRevision?.factAnchors ?? []).map((anchor) => [anchor.logicalSeriesKey, anchor]));
  const deltas: DossierFactDelta[] = [];
  const latestBySeries = new Map<string, ResearchDossierProjectionInput["financialFacts"][number]>();
  for (const candidate of input.financialFacts) {
    const key = seriesKey(candidate.fact);
    const prior = latestBySeries.get(key);
    if (!prior || factRecency(candidate.fact) > factRecency(prior.fact)) latestBySeries.set(key, candidate);
  }
  const sorted = [...latestBySeries.values()].sort((left, right) => seriesKey(left.fact).localeCompare(seriesKey(right.fact)));
  for (const current of sorted) {
    const logicalSeriesKey = seriesKey(current.fact);
    const previous = anchors.get(logicalSeriesKey) ?? null;
    if (previous && current.fact.period.end < previous.period.end) continue;
    const anchor = factAnchor(current.fact, current.evidenceItemId, input.researchFingerprint);
    const kind = deltaKind(previous, anchor);
    if (!kind) continue;
    const delta: DossierFactDelta = {
      id: boundedDerivedId("fact-delta", `${logicalSeriesKey}:${datePart(current.fact.period.end)}:${kind}`),
      kind,
      logicalSeriesKey,
      previous,
      current: anchor,
    };
    deltas.push(delta);
    if (anchor.quality.reliable) anchors.set(logicalSeriesKey, anchor);
  }
  return deltas;
}

function factAnchor(fact: FinancialMetricFact, evidenceId: string, researchFingerprint: Sha256Fingerprint): DossierFactAnchor {
  return {
    id: fact.id,
    logicalSeriesKey: seriesKey(fact),
    factId: fact.id,
    evidenceId,
    researchFingerprint,
    instrumentId: fact.subjectId,
    metric: fact.metric,
    period: structuredClone(fact.period),
    value: structuredClone(fact.value),
    ...(fact.formula ? { formula: structuredClone(fact.formula) } : {}),
    comparisons: structuredClone(fact.comparisons ?? []),
    provenance: structuredClone(fact.provenance),
    quality: structuredClone(fact.quality),
  };
}

function deltaKind(previous: DossierFactAnchor | null, current: DossierFactAnchor): DossierFactDelta["kind"] | null {
  if (!previous) return "baseline_added";
  if (current.period.end > previous.period.end) return "period_advanced";
  if (current.period.start !== previous.period.start) return "source_revised";
  if (previous.value.decimal !== current.value.decimal || stableJson(previous.formula) !== stableJson(current.formula)
    || stableJson(previous.comparisons) !== stableJson(current.comparisons)
    || stableJson(previous.provenance.sourceArtifactIds) !== stableJson(current.provenance.sourceArtifactIds)
    || previous.provenance.sourceAsOf !== current.provenance.sourceAsOf) return "source_revised";
  if (previous.quality.status !== current.quality.status || previous.quality.reliable !== current.quality.reliable
    || stableJson(previous.quality.coverage) !== stableJson(current.quality.coverage)
    || stableJson(previous.quality.warnings) !== stableJson(current.quality.warnings)) return "quality_changed";
  return null;
}

function parseThesisImpacts(value: unknown, theses: ThesisStatement[], deltas: DossierFactDelta[]): ThesisImpact[] {
  const issues = validateThesisImpactClassifierOutput(value, { thesisIds: theses.map((thesis) => thesis.id), factDeltas: deltas });
  if (issues.length > 0) throw new Error("THESIS_IMPACT_INVALID");
  const output = value as ThesisImpactClassifierOutput;
  const thesisIds = new Set(theses.map((thesis) => thesis.id));
  const reliableDeltas = new Map(deltas.filter((delta) => delta.current.quality.reliable).map((delta) => [delta.id, delta]));
  const seen = new Set<string>();
  return output.impacts.map((entry) => {
    const thesisId = entry.thesisId;
    const explanation = entry.explanation;
    if (!thesisIds.has(thesisId) || seen.has(thesisId) || containsNumberOrTrade(explanation)) throw new Error("THESIS_IMPACT_INVALID");
    seen.add(thesisId);
    const impact = entry.impact;
    const factDeltaIds = entry.factDeltaIds;
    const evidenceIds = entry.evidenceIds;
    if (factDeltaIds.some((id) => !reliableDeltas.has(id))) throw new Error("THESIS_IMPACT_INVALID");
    const allowedEvidenceIds = new Set(factDeltaIds.map((id) => reliableDeltas.get(id)!.current.evidenceId));
    if (evidenceIds.some((id) => !allowedEvidenceIds.has(id))) throw new Error("THESIS_IMPACT_INVALID");
    return { id: boundedDerivedId("thesis-impact", `${thesisId}:${impact}`), thesisId, impact, explanation, factDeltaIds, evidenceIds };
  });
}

function dossierBase(input: ResearchDossierProjectionInput): DossierBaseReceipt {
  return input.baseRevision ? {
    schemaVersion: DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
    profileId: input.profileId,
    instrumentId: input.instrumentId,
    dossierId: input.baseRevision.dossierId,
    revisionId: input.baseRevision.id,
      dossierVersion: input.baseRevision.revisionNumber,
    dossierFingerprint: input.baseRevision.fingerprint,
  } : {
    schemaVersion: DOSSIER_BASE_RECEIPT_SCHEMA_VERSION,
    profileId: input.profileId,
    instrumentId: input.instrumentId,
    dossierId: null,
    revisionId: null,
    dossierVersion: 0,
    dossierFingerprint: null,
  };
}

function assertInput(input: ResearchDossierProjectionInput, controls: DossierProjectionControls): void {
  if (![input.runId, input.profileId].every(boundedId) || !/^(SSE|SZSE):\d{6}$/.test(input.instrumentId)
    || !isFingerprint(input.evidenceFingerprint) || !isFingerprint(input.researchFingerprint)
    || !isCanonicalIso(input.observationCutoff) || !isCanonicalIso(input.knowledgeCutoff) || !isCanonicalIso(controls.projectedAt)
    || Date.parse(input.observationCutoff) > Date.parse(input.knowledgeCutoff) || Date.parse(input.knowledgeCutoff) > Date.parse(controls.projectedAt)
    || input.financialFacts.length > 50
    || input.financialFacts.some(({ fact, evidenceItemId }) => fact.kind !== "financial_metric" || fact.subjectId !== input.instrumentId || !boundedId(evidenceItemId))
    || (input.baseRevision !== null && (input.baseRevision.profileId !== input.profileId || input.baseRevision.instrumentId !== input.instrumentId))) throw new Error("DOSSIER_PROJECTION_INPUT_INVALID");
}

function seriesKey(fact: FinancialMetricFact): string { return `${fact.subjectId}:${fact.metric}:${fact.period.basis}`; }
function datePart(value: string): string { return value.slice(0, 10); }
function factRecency(fact: FinancialMetricFact): string { return `${fact.period.end}|${fact.provenance.sourceAsOf}|${fact.provenance.retrievedAt}|${fact.id}`; }
function boundedDerivedId(prefix: string, body: string): string { const value = `${prefix}:${body}`; if (value.length > 128) throw new Error("DOSSIER_IDENTIFIER_TOO_LONG"); return value; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isFingerprint(value: unknown): value is Sha256Fingerprint { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function isCanonicalIso(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function boundedId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value); }
function containsNumberOrTrade(value: string): boolean { return /[0-9０-９]|\b(?:buy|sell|short|long|trade|purchase)\b|下单|买入|卖出|加仓|减仓|做多|做空/i.test(value); }
