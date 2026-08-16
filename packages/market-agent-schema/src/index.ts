import type { MarketSnapshot } from "@zxlab/market-schema";

export const MARKET_AGENT_SCHEMA_VERSION = "market-agent.v1" as const;
export const EVENT_RULE_VERSION = "market-event.v1" as const;
export const RESEARCH_REPORT_VERSION = "research-report.v2" as const;
export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = "portfolio-snapshot.v1" as const;
export const PORTFOLIO_SNAPSHOT_MAX_POSITIONS = 200;
export const PORTFOLIO_SNAPSHOT_MAX_TTL_MS = 36 * 60 * 60 * 1_000;
export const PORTFOLIO_SNAPSHOT_MAX_AGE_MS = 36 * 60 * 60 * 1_000;

export const ASK_SCOPES = [
  "today_change",
  "relative_performance",
  "news_and_announcements",
  "data_quality",
  "portfolio_impact",
  "compare_previous_run",
] as const;

export type AskScope = typeof ASK_SCOPES[number];
export type AgentWorkflow = "morning_brief" | "close_review" | "inspect_instrument" | "portfolio_impact" | "ask";
export type RunTrigger = "manual" | "scheduled" | "bot";
export type AgentFeedbackValue = "helpful" | "fact_error" | "missing_factor";
export interface AgentFeedback { value: AgentFeedbackValue; updatedAt: string; }
export type RunStatus = "queued" | "collecting" | "evidence_sealed" | "generating" | "validating" | "retry_wait" | "success" | "partial" | "failed";
export type EvidenceKind = "market_fact" | "market_event" | "snapshot_diff" | "portfolio_impact" | "confirmed_context" | "limitation" | "execution_plan" | "prior_run";
export type ObservationClass = "fact" | "inference" | "unknown";
export type ObservationImportance = "high" | "medium" | "low";
export type EvidenceCoverage = "sufficient" | "limited" | "insufficient";
export type EvidenceDelivery = "primary" | "fallback";
export interface EvidenceLimitation { code: string; capability?: string; severity: "advisory" | "material" | "blocking"; message: string; }
export interface EvidenceAssessment { coverage: EvidenceCoverage; delivery: EvidenceDelivery; fallbackCapabilities: string[]; limitations: EvidenceLimitation[]; }
export type NarrationValidationCategory =
  | "schema"
  | "summary_length"
  | "context_leakage"
  | "citation_scope"
  | "numeric_grounding"
  | "evidence_reliability"
  | "material_limitations"
  | "trading_policy"
  | "repair_unavailable"
  | "unknown";
export type NarrationValidationRule =
  | "unexpected_field"
  | "status_invalid"
  | "headline_invalid"
  | "summary_invalid"
  | "fingerprint_mismatch"
  | "conclusion_evidence_invalid"
  | "observation_collection_invalid"
  | "observation_id_invalid"
  | "observation_class_invalid"
  | "observation_importance_invalid"
  | "observation_title_invalid"
  | "observation_explanation_invalid"
  | "observation_evidence_invalid"
  | "observation_uncertainty_missing"
  | "watch_collection_invalid"
  | "limitations_invalid"
  | "trading_instruction"
  | "summary_sentence_count"
  | "context_leakage"
  | "conclusion_context"
  | "numeric_claim"
  | "status_limitation_mismatch"
  | "limitation_missing"
  | "unreliable_fact"
  | "observation_context"
  | "watch_citation"
  | "repair_unavailable"
  | "unknown";
export interface NarrationProvenance {
  source: "model" | "model_repaired" | "deterministic_fallback" | "unknown";
  provider?: string;
  model?: string;
  fallbackIndex?: number;
  gatewayRequestId?: string;
  failure?: {
    stage: "configuration" | "gateway" | "protocol" | "validation";
    code: string;
    retryable: boolean;
    /** Bounded diagnostic categories only. Never persist validator messages or model output. */
    validationCategories?: NarrationValidationCategory[];
    /** Stable rule identifiers only. Array indexes and validator text are intentionally discarded. */
    validationRuleIds?: NarrationValidationRule[];
  };
}
export interface RunOutcome { execution: "completed"; narration: NarrationProvenance; evidence: EvidenceAssessment; mode: "market-only" | "portfolio-aware"; }

export interface BrowserRunIntent { workflow: Exclude<AgentWorkflow, "ask">; instrumentId?: string; question?: string; marketDate?: string; idempotencyKey: string; }
export interface BrowserAskIntent { scope: AskScope; instrumentId?: string; question?: string; priorRunId?: string; idempotencyKey: string; }
export interface MarketAgentRunCommand extends BrowserRunIntent { profileId: string; trigger: RunTrigger; }
export interface MarketAgentAskCommand extends BrowserAskIntent {
  workflow: "ask";
  profileId: string;
  trigger: Extract<RunTrigger, "manual" | "bot">;
  /** Resolved by the server when the request is queued; never browser-controlled. */
  resolvedInstrumentIds: string[];
}
export type MarketAgentCommand = MarketAgentRunCommand | MarketAgentAskCommand;
export interface MarketEvent { id: string; ruleId: string; instrumentId: string | null; kind: string; observedAt: string; actual: number | string | null; threshold: number | string | null; reliable: boolean; evidenceId: string; dedupeKey: string; }
export type ConfirmedContextRole = "preference" | "watch_reason" | "belief" | "constraint";
export interface ConfirmedContextUse { memoryId: string; role: ConfirmedContextRole; revisionHash: `sha256:${string}`; usedAt: string; }
export interface ConfirmedContext {
  memoryId: string;
  role: ConfirmedContextRole;
  revisionHash: `sha256:${string}`;
  namespace: "global" | "markets";
  kind: "preference" | "fact" | "decision" | "summary";
  sourceType: string;
  content: string;
  updatedAt: string;
  expiresAt?: string;
}
export interface EvidenceItem { id: string; kind: EvidenceKind; origin: "server-observed" | "user-supplied-risk-snapshot" | "canonical-context"; value: unknown; reliable: boolean; }
export interface SealedEvidenceBundle {
  schemaVersion: typeof MARKET_AGENT_SCHEMA_VERSION;
  eventRuleVersion: typeof EVENT_RULE_VERSION;
  profileId: string;
  workflow: AgentWorkflow;
  watchlistRevision: string;
  instrumentIds: string[];
  items: EvidenceItem[];
  contextUses: ConfirmedContextUse[];
  fingerprint: `sha256:${string}`;
  sealedAt: string;
  ask?: { scope: AskScope; planVersion: "ask-plan.v1"; priorRunId?: string };
}
export interface AgentObservation { id: string; class: ObservationClass; importance: ObservationImportance; title: string; explanation: string; evidenceIds: string[]; }
export interface AgentNarration { status: "success" | "partial"; headline: string; summary: string; conclusionEvidenceIds?: string[]; observations: AgentObservation[]; portfolioImpacts: AgentObservation[]; watchNext: Array<{ condition: string; reason: string; evidenceIds: string[] }>; limitations: string[]; evidenceFingerprint: string; }
export interface ResearchReportSource {
  evidenceId: string;
  kind?: EvidenceKind;
  origin?: EvidenceItem["origin"];
  reliable?: boolean;
  providers?: string[];
  asOf?: string;
  retrievedAt?: string;
}
export interface ResearchReportRisk {
  id: string;
  kind: "uncertainty" | "data_boundary";
  title: string;
  explanation: string;
  evidenceIds: string[];
}
export interface ResearchReportV2 {
  version: typeof RESEARCH_REPORT_VERSION;
  conclusion: { headline: string; summary: string; evidenceIds: string[] };
  basis: AgentObservation[];
  analysis: AgentObservation[];
  risks: ResearchReportRisk[];
  watchNext: AgentNarration["watchNext"];
  sources: ResearchReportSource[];
}
export interface AgentResult extends AgentNarration { mode: "market-only" | "portfolio-aware"; askScope?: AskScope; outcome?: RunOutcome; report?: ResearchReportV2; }
export interface PortfolioSnapshotPosition { instrumentId: string; quantity: number; averageCost: number; }
export interface PortfolioSnapshotUpload {
  schemaVersion: typeof PORTFOLIO_SNAPSHOT_SCHEMA_VERSION;
  sourceRevision: string;
  calculatedAt: string;
  effectiveAt: string;
  expiresAt: string;
  positions: PortfolioSnapshotPosition[];
  cash: number;
  rulesVersion: string;
  clientFingerprint?: `sha256:${string}`;
}
export interface PortfolioSnapshot extends Omit<PortfolioSnapshotUpload, "clientFingerprint"> {
  id: string;
  reliable: boolean;
  warnings: string[];
  fingerprint: `sha256:${string}`;
  createdAt: string;
  stoppedAt: string | null;
}
export interface PortfolioSnapshotUploadValidation { snapshot: PortfolioSnapshotUpload | null; issues: string[]; }
export interface AgentRun { id: string; profileId: string; workflow: AgentWorkflow; trigger: RunTrigger; status: RunStatus; idempotencyKey: string; commandHash: string; revisionOfRunId: string | null; portfolioSnapshotId: string | null; attempt: number; recoveryGeneration: number; createdAt: string; updatedAt: string; evidenceFingerprint: string | null; failure: { code: string; retryable: boolean } | null; result?: AgentResult; }

export function compatibleAgentResult(result: AgentResult): AgentResult {
  const compatible = result.outcome ? result : compatibleLegacyOutcome(result);
  return validResearchReportV2(compatible.report) ? compatible : {
    ...compatible,
    report: createResearchReportV2(compatible),
  };
}

function validResearchReportV2(value: unknown): value is ResearchReportV2 {
  const report = recordValue(value);
  const conclusion = recordValue(report?.conclusion);
  return report?.version === RESEARCH_REPORT_VERSION
    && typeof conclusion?.headline === "string"
    && typeof conclusion.summary === "string"
    && stringArray(conclusion.evidenceIds)
    && Array.isArray(report.basis) && report.basis.every(validReportObservation)
    && Array.isArray(report.analysis) && report.analysis.every(validReportObservation)
    && Array.isArray(report.risks) && report.risks.every((risk) => {
      const item = recordValue(risk);
      return typeof item?.id === "string"
        && (item.kind === "uncertainty" || item.kind === "data_boundary")
        && typeof item.title === "string"
        && typeof item.explanation === "string"
        && stringArray(item.evidenceIds);
    })
    && Array.isArray(report.watchNext) && report.watchNext.every((watch) => {
      const item = recordValue(watch);
      return typeof item?.condition === "string" && typeof item.reason === "string" && stringArray(item.evidenceIds);
    })
    && Array.isArray(report.sources) && report.sources.every((source) => typeof recordValue(source)?.evidenceId === "string");
}

function validReportObservation(value: unknown): boolean {
  const item = recordValue(value);
  return typeof item?.id === "string"
    && (item.class === "fact" || item.class === "inference" || item.class === "unknown")
    && (item.importance === "high" || item.importance === "medium" || item.importance === "low")
    && typeof item.title === "string"
    && typeof item.explanation === "string"
    && stringArray(item.evidenceIds);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function compatibleLegacyOutcome(result: AgentResult): AgentResult {
  const limitations = result.limitations ?? [];
  const deterministic = limitations.some((item) => /Gateway 暂不可用|叙事输出未通过|确定性结果/.test(item));
  const evidenceLimitations = limitations
    .filter((item) => !/Gateway 暂不可用|叙事输出未通过|确定性结果/.test(item))
    .map((message): EvidenceLimitation => ({ code: "LEGACY_LIMITATION", severity: "material", message }));
  const coverage: EvidenceCoverage = evidenceLimitations.length ? "limited" : "sufficient";
  return {
    ...result,
    outcome: {
      execution: "completed",
      narration: deterministic
        ? { source: "deterministic_fallback", failure: { stage: "gateway", code: "LEGACY_GATEWAY_FALLBACK", retryable: true } }
        : { source: "unknown" },
      evidence: { coverage, delivery: "primary", fallbackCapabilities: [], limitations: evidenceLimitations },
      mode: result.mode,
    },
  };
}

export function createResearchReportV2(
  narration: Pick<AgentNarration, "headline" | "summary" | "conclusionEvidenceIds" | "observations" | "portfolioImpacts" | "watchNext" | "limitations">,
  evidence?: SealedEvidenceBundle,
): ResearchReportV2 {
  const observations = [...narration.observations, ...narration.portfolioImpacts];
  const basis = observations.filter((item) => item.class === "fact");
  const analysis = observations.filter((item) => item.class === "inference");
  const risks: ResearchReportRisk[] = [
    ...observations.filter((item) => item.class === "unknown").map((item) => ({
      id: item.id,
      kind: "uncertainty" as const,
      title: item.title,
      explanation: item.explanation,
      evidenceIds: [...item.evidenceIds],
    })),
    ...narration.limitations.filter(Boolean).map((limitation, index) => ({
      id: `data-boundary-${index + 1}`,
      kind: "data_boundary" as const,
      title: "数据边界",
      explanation: limitation,
      evidenceIds: [],
    })),
  ];
  const conclusionEvidenceIds = uniqueStrings(narration.conclusionEvidenceIds ?? []).slice(0, 4);
  const referencedIds = uniqueStrings([
    ...conclusionEvidenceIds,
    ...basis.flatMap((item) => item.evidenceIds),
    ...analysis.flatMap((item) => item.evidenceIds),
    ...risks.flatMap((item) => item.evidenceIds),
    ...narration.watchNext.flatMap((item) => item.evidenceIds),
  ]);
  const evidenceById = new Map(evidence?.items.map((item) => [item.id, item]) ?? []);
  return {
    version: RESEARCH_REPORT_VERSION,
    conclusion: {
      headline: narration.headline,
      summary: narration.summary,
      evidenceIds: conclusionEvidenceIds,
    },
    basis: basis.map(cloneObservation),
    analysis: analysis.map(cloneObservation),
    risks,
    watchNext: narration.watchNext.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
    sources: referencedIds.map((evidenceId) => researchReportSource(evidenceId, evidenceById.get(evidenceId))),
  };
}

function cloneObservation(item: AgentObservation): AgentObservation {
  return { ...item, evidenceIds: [...item.evidenceIds] };
}

function researchReportSource(evidenceId: string, item?: EvidenceItem): ResearchReportSource {
  if (!item) return { evidenceId };
  const value = recordValue(item.value);
  const fact = recordValue(value?.fact);
  const provenance = recordValue(fact?.provenance) ?? recordValue(value?.provenance);
  const corroboration = recordValue(value?.corroboration);
  const observations = Array.isArray(corroboration?.observations)
    ? corroboration.observations.flatMap((observation) => {
      const record = recordValue(observation);
      return typeof record?.provider === "string" && record.provider ? [record.provider] : [];
    })
    : [];
  const providers = uniqueStrings([
    ...(Array.isArray(provenance?.providers)
      ? provenance.providers.filter((provider): provider is string => typeof provider === "string" && Boolean(provider))
      : []),
    ...(typeof value?.provider === "string" && value.provider ? [value.provider] : []),
    ...(typeof value?.source === "string" && value.source ? [value.source] : []),
    ...observations,
  ]);
  const asOf = firstString(provenance?.sourceAsOf, value?.asOf, value?.marketTimestamp, value?.publishedAt, value?.receivedAt);
  const retrievedAt = firstString(provenance?.retrievedAt, value?.retrievedAt, value?.receivedAt);
  return {
    evidenceId,
    kind: item.kind,
    origin: item.origin,
    reliable: item.reliable,
    ...(providers.length ? { providers: uniqueStrings(providers) } : {}),
    ...(asOf ? { asOf } : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export interface RunCreation { command: MarketAgentCommand; actorScope: string; commandHash: `sha256:${string}`; revisionOfRunId?: string; portfolioSnapshotId?: string | null; }
export type RunClaimResult = { kind: "claimed"; lease: { run: AgentRun; leaseToken: string; attempt: number; leaseExpiresAt: string } } | { kind: "terminal" } | { kind: "leased"; retryAfter: string } | { kind: "missing" };

export type ActorKind = "human" | "agent";
export interface ActorRequestBinding { method: string; path: string; bodyHash: `sha256:${string}`; }
export interface ActorEnvelopePayload {
  version: 2;
  kind: ActorKind;
  subject: string;
  ownerSubject: string;
  actorId: string;
  scopes: string[];
  audience: "market-agent";
  issuedAt: number;
  expiresAt: number;
  jti: string;
  request: ActorRequestBinding;
}
export interface ActorEnvelopeVerificationOptions { now?: number; request?: ActorRequestBinding; }
export async function signActorEnvelope(payload: ActorEnvelopePayload, secret: string): Promise<string> {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${base64UrlEncode(await hmac(encoded, secret))}`;
}
export async function verifyActorEnvelope(envelope: string | null, secret: string, options: ActorEnvelopeVerificationOptions = {}): Promise<ActorEnvelopePayload> {
  if (!envelope || !secret) throw new Error("ACTOR_ENVELOPE_MISSING");
  if (!options.request) throw new Error("ACTOR_ENVELOPE_REQUEST_MISSING");
  const [encoded, supplied, extra] = envelope.split(".");
  if (!encoded || !supplied || extra) throw new Error("ACTOR_ENVELOPE_INVALID");
  const expected = await hmac(encoded, secret); const actual = base64UrlDecode(supplied);
  if (!timingSafeEqual(expected, actual)) throw new Error("ACTOR_ENVELOPE_INVALID");
  let payload: ActorEnvelopePayload;
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as ActorEnvelopePayload; } catch { throw new Error("ACTOR_ENVELOPE_INVALID"); }
  const now = Math.floor((options.now ?? Date.now()) / 1_000);
  if (!validActorEnvelope(payload, now) || !sameRequestBinding(payload.request, options.request)) throw new Error("ACTOR_ENVELOPE_INVALID");
  return payload;
}
export async function actorRequestBodyHash(request: Request): Promise<`sha256:${string}`> {
  const body = await request.clone().arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return `sha256:${hex(digest)}`;
}
export function createActorRequestBinding(method: string, path: string, bodyHash: `sha256:${string}`): ActorRequestBinding {
  return { method: method.toUpperCase(), path, bodyHash };
}
export async function subjectHash(subject: string, secret: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${subject}`));
  return `sha256:${hex(new Uint8Array(bytes))}`;
}

export function validateBrowserRunIntent(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["intent must be an object"];
  if (!oneOf(value.workflow, ["morning_brief", "close_review", "inspect_instrument", "portfolio_impact"])) issues.push("workflow is invalid");
  if (!validIdempotencyKey(value.idempotencyKey)) issues.push("idempotencyKey is invalid");
  if (value.instrumentId !== undefined && (typeof value.instrumentId !== "string" || value.instrumentId.length > 32)) issues.push("instrumentId is invalid");
  if (value.question !== undefined && (typeof value.question !== "string" || value.question.length > 4000 || value.workflow !== "inspect_instrument")) issues.push("question is invalid");
  if (value.marketDate !== undefined && (typeof value.marketDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.marketDate))) issues.push("marketDate is invalid");
  if ("profileId" in value || "trigger" in value) issues.push("profileId and trigger are server-only");
  return issues;
}

export function validateBrowserAskIntent(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["ask intent must be an object"];
  exactKeys(value, ["scope", "instrumentId", "question", "priorRunId", "idempotencyKey"], "ask", issues);
  if (!oneOf(value.scope, ASK_SCOPES)) issues.push("scope is invalid");
  if (!validIdempotencyKey(value.idempotencyKey)) issues.push("idempotencyKey is invalid");
  if (value.instrumentId !== undefined && (typeof value.instrumentId !== "string" || !/^(SSE|SZSE):\d{6}$/i.test(value.instrumentId.trim()))) issues.push("instrumentId is invalid");
  if (value.question !== undefined && (typeof value.question !== "string" || value.question.trim().length > 800)) issues.push("question is invalid");
  if (value.priorRunId !== undefined && (typeof value.priorRunId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(value.priorRunId))) issues.push("priorRunId is invalid");
  if (value.scope !== "compare_previous_run" && value.priorRunId !== undefined) issues.push("priorRunId is only valid for compare_previous_run");
  if ("profileId" in value || "trigger" in value || "workflow" in value || "resolvedInstrumentIds" in value) issues.push("server-only fields are not allowed");
  return issues;
}

export function isMarketAgentAskCommand(command: MarketAgentCommand): command is MarketAgentAskCommand {
  return command.workflow === "ask";
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,180}$/.test(value);
}

export function normalizePortfolioSnapshotUpload(value: unknown, now = Date.now()): PortfolioSnapshotUploadValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { snapshot: null, issues: ["snapshot must be an object"] };
  exactKeys(value, ["schemaVersion", "sourceRevision", "calculatedAt", "effectiveAt", "expiresAt", "positions", "cash", "rulesVersion", "clientFingerprint"], "snapshot", issues);
  if (value.schemaVersion !== PORTFOLIO_SNAPSHOT_SCHEMA_VERSION) issues.push("schemaVersion is invalid");
  const sourceRevision = normalizedIdentifier(value.sourceRevision, "sourceRevision", issues);
  const calculatedAt = normalizedIso(value.calculatedAt, "calculatedAt", issues);
  const effectiveAt = normalizedIso(value.effectiveAt, "effectiveAt", issues);
  const expiresAt = normalizedIso(value.expiresAt, "expiresAt", issues);
  const rulesVersion = normalizedIdentifier(value.rulesVersion, "rulesVersion", issues);
  const cash = finiteNumber(value.cash, "cash", issues, -1_000_000_000_000_000, 1_000_000_000_000_000);
  const clientFingerprint = value.clientFingerprint === undefined ? undefined : normalizedFingerprint(value.clientFingerprint, "clientFingerprint", issues);
  const positions = normalizePortfolioPositions(value.positions, issues);

  const calculatedAtMs = calculatedAt ? Date.parse(calculatedAt) : NaN;
  const effectiveAtMs = effectiveAt ? Date.parse(effectiveAt) : NaN;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isFinite(calculatedAtMs) && calculatedAtMs > now + 5 * 60 * 1_000) issues.push("calculatedAt cannot be in the future");
  if (Number.isFinite(calculatedAtMs) && now - calculatedAtMs > PORTFOLIO_SNAPSHOT_MAX_AGE_MS) issues.push("calculatedAt is too old");
  if (Number.isFinite(effectiveAtMs) && effectiveAtMs > now + 5 * 60 * 1_000) issues.push("effectiveAt cannot be in the future");
  if (Number.isFinite(calculatedAtMs) && Number.isFinite(effectiveAtMs) && calculatedAtMs > effectiveAtMs) issues.push("calculatedAt must not be after effectiveAt");
  if (Number.isFinite(effectiveAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs <= effectiveAtMs) issues.push("expiresAt must be after effectiveAt");
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) issues.push("expiresAt must be in the future");
  if (Number.isFinite(effectiveAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs - effectiveAtMs > PORTFOLIO_SNAPSHOT_MAX_TTL_MS) issues.push("expiresAt exceeds the allowed snapshot lifetime");

  if (issues.length || !sourceRevision || !calculatedAt || !effectiveAt || !expiresAt || !rulesVersion || cash === null) return { snapshot: null, issues };
  return {
    snapshot: {
      schemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
      sourceRevision,
      calculatedAt,
      effectiveAt,
      expiresAt,
      positions,
      cash,
      rulesVersion,
      ...(clientFingerprint ? { clientFingerprint } : {}),
    },
    issues,
  };
}

export async function calculatePortfolioSnapshotFingerprint(snapshot: Omit<PortfolioSnapshotUpload, "clientFingerprint"> | PortfolioSnapshot): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPortfolioSnapshot(snapshot))));
  return `sha256:${hex(digest)}`;
}

export function canonicalPortfolioSnapshot(snapshot: Omit<PortfolioSnapshotUpload, "clientFingerprint"> | PortfolioSnapshot): string {
  return stableJson({
    schemaVersion: snapshot.schemaVersion,
    sourceRevision: snapshot.sourceRevision,
    calculatedAt: snapshot.calculatedAt,
    effectiveAt: snapshot.effectiveAt,
    expiresAt: snapshot.expiresAt,
    positions: [...snapshot.positions]
      .map((position) => ({ instrumentId: position.instrumentId, quantity: position.quantity, averageCost: position.averageCost }))
      .sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)),
    cash: snapshot.cash,
    rulesVersion: snapshot.rulesVersion,
  });
}

export function validateSealedEvidence(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["evidence must be an object"];
  if (value.schemaVersion !== MARKET_AGENT_SCHEMA_VERSION) issues.push("schemaVersion is invalid");
  if (value.eventRuleVersion !== EVENT_RULE_VERSION) issues.push("eventRuleVersion is invalid");
  if (typeof value.fingerprint !== "string" || !value.fingerprint.startsWith("sha256:")) issues.push("fingerprint is invalid");
  if (!Array.isArray(value.items) || value.items.length > 500) issues.push("items are invalid");
  return issues;
}

export function validateAgentNarration(value: unknown, evidence: SealedEvidenceBundle): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["narration must be an object"];
  exactKeys(value, ["status", "headline", "summary", "conclusionEvidenceIds", "observations", "portfolioImpacts", "watchNext", "limitations", "evidenceFingerprint"], "narration", issues);
  if (!oneOf(value.status, ["success", "partial"])) issues.push("status is invalid");
  if (typeof value.headline !== "string" || value.headline.length === 0 || value.headline.length > 60) issues.push("headline is invalid");
  if (typeof value.summary !== "string" || value.summary.length === 0 || value.summary.length > 600) issues.push("summary is invalid");
  if (value.evidenceFingerprint !== evidence.fingerprint) issues.push("evidenceFingerprint must match sealed evidence");
  const evidenceIds = new Set(evidence.items.map((item) => item.id));
  if (value.conclusionEvidenceIds !== undefined && (!Array.isArray(value.conclusionEvidenceIds) || value.conclusionEvidenceIds.length > 4 || value.conclusionEvidenceIds.some((id) => typeof id !== "string" || !evidenceIds.has(id)))) issues.push("conclusionEvidenceIds must reference at most 4 sealed evidence items");
  for (const field of ["observations", "portfolioImpacts"] as const) {
    const maximum = field === "observations" ? 6 : 4;
    if (!Array.isArray(value[field]) || value[field].length > maximum) { issues.push(`${field} must be an array with at most ${maximum} items`); continue; }
    for (const [index, observation] of value[field].entries()) validateObservation(observation, `${field}[${index}]`, evidenceIds, issues);
  }
  if (!Array.isArray(value.watchNext) || value.watchNext.length > 4) issues.push("watchNext must be an array with at most 4 items");
  if (!Array.isArray(value.limitations) || value.limitations.length > 8 || value.limitations.some((item) => typeof item !== "string" || item.length > 220)) issues.push("limitations must be a bounded string[]");
  const text = JSON.stringify(value).toLowerCase();
  if (/\b(buy|sell|short|long|trade|purchase|下单|买入|卖出|加仓|减仓|做多|做空)\b/.test(text)) issues.push("trading instructions are forbidden");
  return issues;
}

export function eventEvidenceId(runId: string, index: number): string { return `${runId}:event:${index}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function oneOf(value: unknown, values: readonly string[]): boolean { return typeof value === "string" && values.includes(value); }
function exactKeys(value: Record<string, unknown>, allowed: string[], path: string, issues: string[]) { for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key} is not allowed`); }
function normalizedIdentifier(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string") { issues.push(`${path} is invalid`); return null; }
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(normalized)) { issues.push(`${path} is invalid`); return null; }
  return normalized;
}
function normalizedIso(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) { issues.push(`${path} is invalid`); return null; }
  return new Date(value).toISOString();
}
function finiteNumber(value: unknown, path: string, issues: string[], min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) { issues.push(`${path} is invalid`); return null; }
  return Object.is(value, -0) ? 0 : value;
}
function normalizedFingerprint(value: unknown, path: string, issues: string[]): `sha256:${string}` | null {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) { issues.push(`${path} is invalid`); return null; }
  return value as `sha256:${string}`;
}
function normalizePortfolioPositions(value: unknown, issues: string[]): PortfolioSnapshotPosition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PORTFOLIO_SNAPSHOT_MAX_POSITIONS) { issues.push("positions are invalid"); return []; }
  const seen = new Set<string>();
  const normalized: PortfolioSnapshotPosition[] = [];
  value.forEach((entry, index) => {
    const path = `positions[${index}]`;
    if (!isRecord(entry)) { issues.push(`${path} is invalid`); return; }
    exactKeys(entry, ["instrumentId", "quantity", "averageCost"], path, issues);
    const instrumentId = typeof entry.instrumentId === "string" ? entry.instrumentId.trim().toUpperCase() : "";
    const validInstrumentId = /^(SSE|SZSE):\d{6}$/.test(instrumentId) && !seen.has(instrumentId);
    if (!validInstrumentId) issues.push(`${path}.instrumentId is invalid`);
    else seen.add(instrumentId);
    const quantity = finiteNumber(entry.quantity, `${path}.quantity`, issues, Number.MIN_VALUE, 1_000_000_000_000);
    const averageCost = finiteNumber(entry.averageCost, `${path}.averageCost`, issues, 0, 1_000_000_000);
    if (validInstrumentId && quantity !== null && averageCost !== null) normalized.push({ instrumentId, quantity, averageCost });
  });
  return normalized.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function validActorEnvelope(value: ActorEnvelopePayload, now: number): boolean {
  if (!isRecord(value) || value.version !== 2 || value.audience !== "market-agent") return false;
  if (value.kind !== "human" && value.kind !== "agent") return false;
  if (!boundedString(value.subject) || !boundedString(value.ownerSubject) || !boundedString(value.actorId) || !boundedString(value.jti)) return false;
  if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > 32 || new Set(value.scopes).size !== value.scopes.length) return false;
  if (value.scopes.some((item) => typeof item !== "string" || !/^(?:\*|[a-z][a-z0-9-]{0,62}:(?:\*|[a-z][a-z0-9-]{0,62}))$/.test(item))) return false;
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)) return false;
  if (value.issuedAt > now + 5 || value.expiresAt <= now || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 120) return false;
  return validRequestBinding(value.request);
}
function validRequestBinding(value: ActorRequestBinding): boolean {
  if (!isRecord(value) || typeof value.method !== "string" || !/^[A-Z]{1,12}$/.test(value.method)) return false;
  if (typeof value.path !== "string" || !value.path.startsWith("/api/v1/private/market-agent/")) return false;
  return typeof value.bodyHash === "string" && /^sha256:[a-f0-9]{64}$/.test(value.bodyHash);
}
function sameRequestBinding(left: ActorRequestBinding, right: ActorRequestBinding): boolean {
  return left.method === right.method && left.path === right.path && left.bodyHash === right.bodyHash;
}
function boundedString(value: unknown): boolean { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function validateObservation(value: unknown, path: string, evidenceIds: Set<string>, issues: string[]) {
  if (!isRecord(value)) { issues.push(`${path} must be an object`); return; }
  if (typeof value.id !== "string" || !value.id) issues.push(`${path}.id is invalid`);
  if (!oneOf(value.class, ["fact", "inference", "unknown"])) issues.push(`${path}.class is invalid`);
  if (!oneOf(value.importance, ["high", "medium", "low"])) issues.push(`${path}.importance is invalid`);
  if (typeof value.title !== "string" || value.title.length === 0 || value.title.length > 36) issues.push(`${path}.title is invalid`);
  if (typeof value.explanation !== "string" || value.explanation.length === 0 || value.explanation.length > 360) issues.push(`${path}.explanation is invalid`);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0 || value.evidenceIds.some((id) => typeof id !== "string" || !evidenceIds.has(id))) issues.push(`${path}.evidenceIds must reference sealed evidence`);
  if (value.class === "inference" && typeof value.explanation === "string" && !/[?？]|可能|或许|倾向|推测|推断|疑似|不确定|无法确认|不能确认|无法确定|不能确定|尚(?:待|需|无法)确认|尚不明确|有待观察|likely|may|might|could|uncertain|suggests?/i.test(value.explanation)) issues.push(`${path}.inference must use uncertainty language`);
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function base64UrlEncode(value: Uint8Array): string { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64UrlDecode(value: string): Uint8Array { const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export type { MarketSnapshot };
