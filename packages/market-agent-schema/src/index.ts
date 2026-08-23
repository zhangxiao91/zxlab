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
export type RunStatus = "queued" | "collecting" | "evidence_sealed" | "generating" | "validating" | "retry_wait" | "success" | "partial" | "failed" | "cancelled";
export type RunTraceEventType = "run_created" | "stage_started" | "stage_completed" | "retry_scheduled" | "cancel_requested" | "run_cancelled" | "run_completed" | "run_failed";
export type RunTraceOperation = "run.create" | "run.claim" | "run.collect" | "evidence.seal" | "narration.generate" | "result.validate" | "run.retry" | "run.cancel" | "run.complete" | "run.fail";
type ActiveRunStatus = Exclude<RunStatus, "success" | "partial" | "failed" | "cancelled">;
type ExecutingRunStatus = Exclude<ActiveRunStatus, "queued" | "retry_wait">;
interface RunTraceEventBase {
  id: string;
  runId: string;
  sequence: number;
  attempt: number;
  recoveryGeneration: number;
  occurredAt: string;
  provenance: { source: "market-agent-worker"; operation: RunTraceOperation };
}
export type RunTraceEvent = RunTraceEventBase & (
  | { type: "run_created"; stage: "queued"; durationMs?: never; code?: never }
  | { type: "stage_started"; stage: ExecutingRunStatus; durationMs?: never; code?: never }
  | { type: "stage_completed"; stage: ActiveRunStatus; durationMs: number; code?: string }
  | { type: "retry_scheduled"; stage: "retry_wait"; durationMs?: never; code?: string }
  | { type: "cancel_requested"; stage: ActiveRunStatus; durationMs?: never; code?: never }
  | { type: "run_cancelled"; stage: "cancelled"; durationMs: number; code?: never }
  | { type: "run_completed"; stage: "success" | "partial"; durationMs: number; code?: never }
  | { type: "run_failed"; stage: "failed"; durationMs: number; code: string }
);
export interface RunTiming {
  queuedAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  durationMs: number | null;
  serverNow: string;
}
export interface RunTrace { runId: string; timing: RunTiming; events: RunTraceEvent[]; }

const runTraceEventTypes = new Set<RunTraceEventType>(["run_created", "stage_started", "stage_completed", "retry_scheduled", "cancel_requested", "run_cancelled", "run_completed", "run_failed"]);
const runTraceOperations = new Set<RunTraceOperation>(["run.create", "run.claim", "run.collect", "evidence.seal", "narration.generate", "result.validate", "run.retry", "run.cancel", "run.complete", "run.fail"]);
const runStatuses = new Set<RunStatus>(["queued", "collecting", "evidence_sealed", "generating", "validating", "retry_wait", "success", "partial", "failed", "cancelled"]);

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && runStatuses.has(value as RunStatus);
}

export function isRunTraceEvent(value: unknown): value is RunTraceEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const provenance = event.provenance as Record<string, unknown> | undefined;
  const allowedKeys = new Set(["id", "runId", "sequence", "type", "stage", "attempt", "recoveryGeneration", "occurredAt", "durationMs", "provenance", "code"]);
  if (Object.keys(event).some((key) => !allowedKeys.has(key))
    || !provenance || Object.keys(provenance).length !== 2 || !("source" in provenance) || !("operation" in provenance)
    || !boundedTraceIdentifier(event.id) || !boundedTraceIdentifier(event.runId)
    || !Number.isSafeInteger(event.sequence) || Number(event.sequence) <= 0
    || !runTraceEventTypes.has(event.type as RunTraceEventType)
    || !isRunStatus(event.stage)
    || !boundedIsoTimestamp(event.occurredAt)
    || !boundedCounter(event.attempt) || !boundedCounter(event.recoveryGeneration)
    || (event.durationMs !== undefined && !boundedDuration(event.durationMs))
    || (event.code !== undefined && !boundedErrorCode(event.code))
    || provenance?.source !== "market-agent-worker"
    || !runTraceOperations.has(provenance.operation as RunTraceOperation)) return false;
  const hasDuration = boundedDuration(event.durationMs);
  if (event.type === "run_created") return event.stage === "queued" && event.durationMs === undefined && event.code === undefined;
  if (event.type === "stage_started") return ["collecting", "evidence_sealed", "generating", "validating"].includes(String(event.stage)) && event.durationMs === undefined && event.code === undefined;
  if (event.type === "stage_completed") return ["queued", "collecting", "evidence_sealed", "generating", "validating", "retry_wait"].includes(String(event.stage)) && hasDuration;
  if (event.type === "retry_scheduled") return event.stage === "retry_wait" && event.durationMs === undefined;
  if (event.type === "cancel_requested") return isCancellableRunStatus(String(event.stage)) && event.durationMs === undefined && event.code === undefined;
  if (event.type === "run_cancelled") return event.stage === "cancelled" && hasDuration && event.code === undefined;
  if (event.type === "run_completed") return (event.stage === "success" || event.stage === "partial") && hasDuration && event.code === undefined;
  return event.type === "run_failed" && event.stage === "failed" && hasDuration && boundedErrorCode(event.code);
}

export function isRunTiming(value: unknown): value is RunTiming {
  if (!value || typeof value !== "object") return false;
  const timing = value as Record<string, unknown>;
  return boundedIsoTimestamp(timing.queuedAt)
    && (timing.startedAt === null || boundedIsoTimestamp(timing.startedAt))
    && boundedIsoTimestamp(timing.updatedAt)
    && (timing.completedAt === null || boundedIsoTimestamp(timing.completedAt))
    && boundedDuration(timing.elapsedMs)
    && (timing.durationMs === null || boundedDuration(timing.durationMs))
    && boundedIsoTimestamp(timing.serverNow);
}

export function isRunTrace(value: unknown): value is RunTrace {
  if (!value || typeof value !== "object") return false;
  const trace = value as Record<string, unknown>;
  if (!boundedTraceIdentifier(trace.runId) || !isRunTiming(trace.timing) || !Array.isArray(trace.events) || !trace.events.every(isRunTraceEvent)) return false;
  let previousSequence = 0;
  const ids = new Set<string>();
  for (const event of trace.events) {
    if (event.runId !== trace.runId || event.sequence <= previousSequence || ids.has(event.id)) return false;
    previousSequence = event.sequence;
    ids.add(event.id);
  }
  return true;
}

function boundedTraceIdentifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
function boundedIsoTimestamp(value: unknown): value is string { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function boundedCounter(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100; }
function boundedDuration(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function boundedErrorCode(value: unknown): value is string { return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value); }
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
  | "limitation_unsupported"
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
    /** Section names only. Numeric values, text, and array indexes are intentionally discarded. */
    numericSections?: Array<"narration" | "observations" | "portfolioImpacts" | "watchNext" | "limitations">;
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
export type ResearchReportFactKind = "instrument_mapping" | "market_baseline" | "financial_metric" | "valuation";
export type ResearchReportFactUnit = "CNY" | "ratio" | "shares";
export interface ResearchReportFactFormula {
  id: string;
  version: string;
  expression: string;
  inputArtifactIds: string[];
  parameters: Record<string, string>;
  rounding: string;
}
export interface ResearchReportFactMetric {
  key: "value" | "weight" | "comparison" | "comparison_yoy" | "comparison_qoq" | "historical_percentile";
  label: string;
  decimal: string;
  unit: ResearchReportFactUnit;
  formula?: ResearchReportFactFormula;
}
export interface ResearchReportFactBlock {
  id: string;
  evidenceId: string;
  factId: string;
  kind: ResearchReportFactKind;
  subjectId: string;
  title: string;
  context: Array<{ label: string; value: string }>;
  metrics: ResearchReportFactMetric[];
  quality: {
    status: "operational" | "degraded";
    reliable: boolean;
    coverage: { actual: number; required: number };
    warnings: string[];
  };
  provenance: {
    researchFingerprint: string;
    planVersion: string;
    providers: string[];
    sourceArtifactIds: string[];
    sourceAsOf: string;
    retrievedAt: string;
  };
}
export interface ResearchReportV2 {
  version: typeof RESEARCH_REPORT_VERSION;
  conclusion: { headline: string; summary: string; evidenceIds: string[] };
  /** Present on reports built with sealed Research Fact evidence. Absent means a legacy report, not an empty current report. */
  factBlocks?: ResearchReportFactBlock[];
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
export interface AgentRun { id: string; profileId: string; workflow: AgentWorkflow; trigger: RunTrigger; status: RunStatus; idempotencyKey: string; commandHash: string; revisionOfRunId: string | null; portfolioSnapshotId: string | null; attempt: number; recoveryGeneration: number; createdAt: string; updatedAt: string; evidenceFingerprint: string | null; failure: { code: string; retryable: boolean } | null; timing?: RunTiming; result?: AgentResult; }

export function isTerminalRunStatus(status: string): status is Extract<RunStatus, "success" | "partial" | "failed" | "cancelled"> {
  return status === "success" || status === "partial" || status === "failed" || status === "cancelled";
}

export function isCancellableRunStatus(status: string): status is Exclude<RunStatus, "success" | "partial" | "failed" | "cancelled"> {
  return status === "queued" || status === "collecting" || status === "evidence_sealed" || status === "generating" || status === "validating" || status === "retry_wait";
}

export function isRetryableRunStatus(status: string): status is Extract<RunStatus, "failed" | "cancelled"> {
  return status === "failed" || status === "cancelled";
}

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
    && (report.factBlocks === undefined || (Array.isArray(report.factBlocks) && report.factBlocks.every(validReportFactBlock)))
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
    && Array.isArray(report.sources) && report.sources.every((source) => typeof recordValue(source)?.evidenceId === "string")
    && validFactBlockReferences(report.factBlocks, report.sources);
}

function validFactBlockReferences(blocksValue: unknown, sourcesValue: unknown): boolean {
  if (blocksValue === undefined) return true;
  if (!Array.isArray(blocksValue) || !Array.isArray(sourcesValue)) return false;
  const sources = new Map(sourcesValue.flatMap((value) => {
    const source = recordValue(value);
    return typeof source?.evidenceId === "string" ? [[source.evidenceId, source] as const] : [];
  }));
  const ids = new Set<string>();
  const factIds = new Set<string>();
  const evidenceIds = new Set<string>();
  return blocksValue.every((value) => {
    const block = recordValue(value);
    const provenance = recordValue(block?.provenance);
    if (!block || !provenance || typeof block.id !== "string" || typeof block.factId !== "string" || typeof block.evidenceId !== "string" || ids.has(block.id) || factIds.has(block.factId) || evidenceIds.has(block.evidenceId)) return false;
    ids.add(block.id); factIds.add(block.factId); evidenceIds.add(block.evidenceId);
    const source = sources.get(block.evidenceId);
    if (!source || source.kind !== "market_fact" || source.origin !== "server-observed" || source.asOf !== provenance.sourceAsOf || source.retrievedAt !== provenance.retrievedAt || !sameStrings(source.providers, provenance.providers)) return false;
    const artifacts = new Set(Array.isArray(provenance.sourceArtifactIds) ? provenance.sourceArtifactIds : []);
    return Array.isArray(block.metrics) && block.metrics.every((metricValue) => {
      const formula = recordValue(recordValue(metricValue)?.formula);
      return !formula || (Array.isArray(formula.inputArtifactIds) && formula.inputArtifactIds.every((artifact) => typeof artifact === "string" && artifacts.has(artifact)));
    });
  });
}

function sameStrings(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.every((item) => typeof item === "string") || !right.every((item) => typeof item === "string")) return false;
  const expected = new Set(right);
  return expected.size === right.length && left.length === right.length && left.every((item) => expected.has(item));
}

function validReportFactBlock(value: unknown): boolean {
  const block = recordValue(value);
  const quality = recordValue(block?.quality);
  const coverage = recordValue(quality?.coverage);
  const provenance = recordValue(block?.provenance);
  return typeof block?.id === "string"
    && typeof block.evidenceId === "string"
    && typeof block.factId === "string"
    && ["instrument_mapping", "market_baseline", "financial_metric", "valuation"].includes(String(block.kind))
    && typeof block.subjectId === "string"
    && typeof block.title === "string"
    && Array.isArray(block.context) && block.context.every((entry) => typeof recordValue(entry)?.label === "string" && typeof recordValue(entry)?.value === "string")
    && validReportFactMetrics(block.metrics)
    && (quality?.status === "operational" || quality?.status === "degraded")
    && typeof quality.reliable === "boolean"
    && Number.isSafeInteger(coverage?.actual) && Number(coverage?.actual) >= 0
    && Number.isSafeInteger(coverage?.required) && Number(coverage?.required) > 0
    && stringArray(quality.warnings)
    && typeof provenance?.researchFingerprint === "string"
    && typeof provenance.planVersion === "string"
    && stringArray(provenance.providers) && provenance.providers.length > 0
    && stringArray(provenance.sourceArtifactIds) && provenance.sourceArtifactIds.length > 0
    && boundedIsoTimestamp(provenance.sourceAsOf)
    && boundedIsoTimestamp(provenance.retrievedAt);
}

function validReportFactMetrics(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || !value.every(validReportFactMetric)) return false;
  const keys = value.map((metric) => recordValue(metric)?.key);
  return new Set(keys).size === keys.length;
}

function validReportFactMetric(value: unknown): boolean {
  const metric = recordValue(value);
  const formula = recordValue(metric?.formula);
  return ["value", "weight", "comparison", "comparison_yoy", "comparison_qoq", "historical_percentile"].includes(String(metric?.key))
    && typeof metric?.label === "string"
    && typeof metric.decimal === "string" && /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(metric.decimal)
    && ["CNY", "ratio", "shares"].includes(String(metric.unit))
    && (formula === undefined || (
      typeof formula.id === "string"
      && typeof formula.version === "string"
      && typeof formula.expression === "string"
      && stringArray(formula.inputArtifactIds)
      && formula.inputArtifactIds.length > 0
      && stringRecord(formula.parameters)
      && typeof formula.rounding === "string"
    ));
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
  const factBlocks = evidence ? researchReportFactBlocks(evidence) : undefined;
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
    ...(factBlocks?.map((block) => block.evidenceId) ?? []),
  ]);
  const evidenceById = new Map(evidence?.items.map((item) => [item.id, item]) ?? []);
  return {
    version: RESEARCH_REPORT_VERSION,
    conclusion: {
      headline: narration.headline,
      summary: narration.summary,
      evidenceIds: conclusionEvidenceIds,
    },
    ...(factBlocks ? { factBlocks } : {}),
    basis: basis.map(cloneObservation),
    analysis: analysis.map(cloneObservation),
    risks,
    watchNext: narration.watchNext.map((item) => ({ ...item, evidenceIds: [...item.evidenceIds] })),
    sources: referencedIds.map((evidenceId) => researchReportSource(evidenceId, evidenceById.get(evidenceId))),
  };
}

function researchReportFactBlocks(evidence: SealedEvidenceBundle): ResearchReportFactBlock[] {
  return evidence.items.flatMap((item) => {
    if (item.kind !== "market_fact" || item.origin !== "server-observed") return [];
    const value = recordValue(item.value);
    const fact = recordValue(value?.fact);
    const provenance = recordValue(fact?.provenance);
    const quality = recordValue(fact?.quality);
    const coverage = recordValue(quality?.coverage);
    if (
      value?.type !== "research_fact"
      || typeof value.researchFingerprint !== "string"
      || typeof value.planVersion !== "string"
      || !fact
      || typeof fact.id !== "string"
      || typeof fact.subjectId !== "string"
      || !provenance
      || !quality
      || !coverage
      || !Array.isArray(provenance.providers)
      || !Array.isArray(provenance.sourceArtifactIds)
      || typeof provenance.sourceAsOf !== "string"
      || typeof provenance.retrievedAt !== "string"
      || (quality.status !== "operational" && quality.status !== "degraded")
      || typeof quality.reliable !== "boolean"
      || !Number.isSafeInteger(coverage.actual)
      || !Number.isSafeInteger(coverage.required)
      || !Array.isArray(quality.warnings)
    ) return [];
    const metrics = researchFactMetrics(fact);
    if (!metrics.length) return [];
    const kind = fact.kind;
    if (kind !== "instrument_mapping" && kind !== "market_baseline" && kind !== "financial_metric" && kind !== "valuation") return [];
    return [{
      id: `fact-block:${item.id}`,
      evidenceId: item.id,
      factId: fact.id,
      kind,
      subjectId: fact.subjectId,
      title: researchFactTitle(fact),
      context: researchFactContext(fact),
      metrics,
      quality: {
        status: quality.status,
        reliable: item.reliable && quality.reliable,
        coverage: { actual: Number(coverage.actual), required: Number(coverage.required) },
        warnings: uniqueStrings(quality.warnings.filter((warning): warning is string => typeof warning === "string")),
      },
      provenance: {
        researchFingerprint: value.researchFingerprint,
        planVersion: value.planVersion,
        providers: uniqueStrings(provenance.providers.filter((provider): provider is string => typeof provider === "string")),
        sourceArtifactIds: uniqueStrings(provenance.sourceArtifactIds.filter((artifact): artifact is string => typeof artifact === "string")),
        sourceAsOf: provenance.sourceAsOf,
        retrievedAt: provenance.retrievedAt,
      },
    }];
  });
}

function researchFactMetrics(fact: Record<string, unknown>): ResearchReportFactMetric[] {
  if (fact.kind === "market_baseline") return metric(fact.value, "value", baselineLabel(fact.baselineType), fact.formula);
  if (fact.kind === "instrument_mapping") return metric(fact.weight, "weight", "指数权重");
  if (fact.kind === "financial_metric") {
    const comparisons = Array.isArray(fact.comparisons)
      ? fact.comparisons.flatMap((value) => recordValue(value) ? [recordValue(value)!] : [])
      : [];
    comparisons.sort((left, right) => comparisonOrder(left.kind) - comparisonOrder(right.kind));
    return [
      ...metric(fact.value, "value", financialMetricLabel(fact.metric), fact.formula),
      ...metric(fact.comparison, "comparison", comparisonLabel(recordValue(fact.comparison)?.kind), recordValue(fact.comparison)?.formula),
      ...comparisons.flatMap((comparison) => comparison.kind === "yoy" || comparison.kind === "qoq"
        ? metric(comparison, comparison.kind === "yoy" ? "comparison_yoy" : "comparison_qoq", comparisonLabel(comparison.kind), comparison.formula)
        : []),
    ];
  }
  if (fact.kind === "valuation") return [
    ...metric(fact.value, "value", valuationLabel(fact.metric)),
    ...metric(fact.historicalPercentile, "historical_percentile", "历史分位", recordValue(fact.historicalPercentile)?.formula),
  ];
  return [];
}

function metric(value: unknown, key: ResearchReportFactMetric["key"], label: string, formulaValue?: unknown): ResearchReportFactMetric[] {
  const source = recordValue(value);
  if (!source || typeof source.decimal !== "string" || !/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source.decimal) || (source.unit !== "CNY" && source.unit !== "ratio" && source.unit !== "shares")) return [];
  const formula = researchReportFormula(formulaValue);
  return [{ key, label, decimal: source.decimal, unit: source.unit, ...(formula ? { formula } : {}) }];
}

function researchReportFormula(value: unknown): ResearchReportFactFormula | undefined {
  const formula = recordValue(value);
  if (!formula || typeof formula.id !== "string" || typeof formula.version !== "string" || typeof formula.expression !== "string" || !Array.isArray(formula.inputArtifactIds) || typeof formula.rounding !== "string" || !stringRecord(formula.parameters)) return undefined;
  const inputArtifactIds = formula.inputArtifactIds.filter((id): id is string => typeof id === "string" && Boolean(id));
  if (!inputArtifactIds.length) return undefined;
  return { id: formula.id, version: formula.version, expression: formula.expression, inputArtifactIds: uniqueStrings(inputArtifactIds), parameters: { ...formula.parameters }, rounding: formula.rounding };
}

function researchFactTitle(fact: Record<string, unknown>): string {
  if (fact.kind === "market_baseline") return `${fact.subjectId} · ${String(fact.window)} 日${baselineLabel(fact.baselineType)}`;
  if (fact.kind === "instrument_mapping") return `${fact.subjectId} · ${mappingLabel(fact.mappingType)}`;
  if (fact.kind === "financial_metric") return `${fact.subjectId} · ${financialMetricLabel(fact.metric)}`;
  return `${fact.subjectId} · ${valuationLabel(fact.metric)}`;
}

function researchFactContext(fact: Record<string, unknown>): Array<{ label: string; value: string }> {
  if (fact.kind === "market_baseline") {
    const period = recordValue(fact.observationPeriod);
    return [
      ...(typeof fact.benchmarkId === "string" ? [{ label: "基准", value: fact.benchmarkId }] : []),
      ...(typeof period?.start === "string" && typeof period.end === "string" ? [{ label: "观察区间", value: `${period.start} — ${period.end}` }] : []),
    ];
  }
  if (fact.kind === "instrument_mapping") return [
    ...(typeof fact.targetId === "string" ? [{ label: "映射目标", value: fact.targetId }] : []),
    ...(typeof fact.methodologyVersion === "string" ? [{ label: "方法版本", value: fact.methodologyVersion }] : []),
  ];
  const period = recordValue(fact.period);
  const comparisons = Array.isArray(fact.comparisons)
    ? fact.comparisons.flatMap((value) => recordValue(value) ? [recordValue(value)!] : [])
    : [];
  comparisons.sort((left, right) => comparisonOrder(left.kind) - comparisonOrder(right.kind));
  return [
    ...(period && typeof period.start === "string" && typeof period.end === "string"
      ? [{ label: "报告期", value: `${period.start} — ${period.end}` }]
      : []),
    ...(typeof period?.basis === "string" ? [{ label: "报告口径", value: reportingBasisLabel(period.basis) }] : []),
    ...comparisons.flatMap((comparison) => {
      const comparable = recordValue(comparison.comparablePeriod);
      if ((comparison.kind !== "yoy" && comparison.kind !== "qoq") || typeof comparable?.start !== "string" || typeof comparable.end !== "string") return [];
      return [{ label: `${comparisonLabel(comparison.kind)}可比期`, value: `${comparable.start} — ${comparable.end}` }];
    }),
  ];
}

function baselineLabel(value: unknown): string {
  return ({ price_return: "价格收益", volume_median: "成交量中位数", realized_volatility: "实现波动率", relative_return: "相对收益" } as Record<string, string>)[String(value)] ?? "市场基线";
}
function mappingLabel(value: unknown): string { return ({ benchmark: "基准映射", industry: "行业映射", index_membership: "指数成分" } as Record<string, string>)[String(value)] ?? "标的映射"; }
function valuationLabel(value: unknown): string { return ({ pe_ttm: "市盈率 TTM", pb: "市净率", ps_ttm: "市销率 TTM", dividend_yield: "股息率" } as Record<string, string>)[String(value)] ?? "估值指标"; }
function comparisonLabel(value: unknown): string { return value === "yoy" ? "同比" : value === "qoq" ? "环比" : "指标变化"; }
function comparisonOrder(value: unknown): number { return value === "yoy" ? 0 : value === "qoq" ? 1 : 2; }
function financialMetricLabel(value: unknown): string {
  const label = ({
    operating_revenue: "营业收入",
    operating_profit: "营业利润",
    net_profit_attributable_to_parent: "归母净利润",
    net_cash_flow_from_operating_activities: "经营现金流",
    total_assets: "总资产",
  } as Record<string, string>)[String(value)];
  return label ?? (typeof value === "string" && value ? value : "财务指标");
}
function reportingBasisLabel(value: unknown): string {
  return ({ quarter: "单季度", single_quarter: "单季度", year_to_date: "年初至报告期末", fiscal_year: "财政年度", point_in_time: "期末时点" } as Record<string, string>)[String(value)] ?? String(value);
}
function stringRecord(value: unknown): value is Record<string, string> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"); }

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
