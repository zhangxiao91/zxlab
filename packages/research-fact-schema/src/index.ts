export const RESEARCH_FACT_SCHEMA_VERSION = "research-facts.v2" as const;

export type ResearchPurpose =
  | "price_context"
  | "relative_performance"
  | "company_update"
  | "company_research"
  | "event_calendar";

export interface ResearchFactRequest {
  purpose: ResearchPurpose;
  instrumentIds: string[];
  selectedInstrumentId?: string;
  observationCutoff: string;
  expectedLatestSessionDate?: string;
}

export interface ResearchFactValidation {
  ok: boolean;
  issues: string[];
}

export type MarketBaselineWindow = 20 | 60 | 250;
export type MarketBaselineType = "price_return" | "volume_median" | "realized_volatility" | "relative_return";
export type ResearchCapabilityId = "instrument_mapping" | "market_baselines" | "fundamentals" | "valuation" | "documents" | "calendar";
export type ResearchCapabilityStatus = "operational" | "degraded" | "unavailable";

export interface ResearchCapabilityLimitation {
  code: string;
  subjectId?: string;
  baselineType?: MarketBaselineType;
  window?: MarketBaselineWindow;
  actual?: number;
  required?: number;
  expectedSessionDate?: string;
  actualSessionDate?: string;
  retryable: boolean;
}

export interface FactProvenance {
  providers: string[];
  sourceArtifactIds: string[];
  sourceAsOf: string;
  retrievedAt: string;
}

export interface FactQuality {
  status: Extract<ResearchCapabilityStatus, "operational" | "degraded">;
  reliable: boolean;
  coverage: { actual: number; required: number };
  warnings: string[];
}

export interface DeterministicFormula {
  id: string;
  version: string;
  expression: string;
  inputArtifactIds: string[];
  parameters: Record<string, string>;
  rounding: string;
}

export interface InstrumentMappingFact {
  id: string;
  kind: "instrument_mapping";
  subjectId: string;
  mappingType: "benchmark" | "industry" | "index_membership";
  targetId: string;
  weight?: { decimal: string; unit: "ratio" };
  validFrom: string;
  validTo: string | null;
  methodologyVersion: string;
  provenance: FactProvenance;
  quality: FactQuality;
}

export interface MarketBaselineFact {
  id: string;
  kind: "market_baseline";
  subjectId: string;
  baselineType: MarketBaselineType;
  window: MarketBaselineWindow;
  benchmarkId?: string;
  observationPeriod: { start: string; end: string; tradingSessions: number };
  value: { decimal: string; unit: "ratio" | "shares" };
  formula: DeterministicFormula;
  provenance: FactProvenance;
  quality: FactQuality;
}

export interface FinancialMetricFact {
  id: string;
  kind: "financial_metric";
  subjectId: string;
  metric: string;
  period: { start: string; end: string; basis: "quarter" | "year_to_date" | "fiscal_year" };
  value: { decimal: string; unit: "CNY" | "ratio" | "shares" };
  comparison?: { kind: "yoy" | "qoq"; decimal: string; unit: "ratio"; formula: DeterministicFormula };
  provenance: FactProvenance;
  quality: FactQuality;
}

export interface ValuationFact {
  id: string;
  kind: "valuation";
  subjectId: string;
  metric: "pe_ttm" | "pb" | "ps_ttm" | "dividend_yield";
  value: { decimal: string; unit: "ratio" };
  historicalPercentile?: { decimal: string; unit: "ratio"; formula: DeterministicFormula };
  provenance: FactProvenance;
  quality: FactQuality;
}

export interface DocumentParagraphFact {
  id: string;
  kind: "document_paragraph";
  subjectId: string;
  documentId: string;
  versionId: string;
  paragraphId: string;
  ordinal: number;
  text: string;
  contentDigest: `sha256:${string}`;
  provenance: FactProvenance;
  quality: FactQuality;
}

export interface DocumentVersionDiffFact {
  id: string;
  kind: "document_version_diff";
  subjectId: string;
  documentId: string;
  fromVersionId: string;
  toVersionId: string;
  algorithm: { id: "paragraph-diff"; version: string };
  changes: Array<{ kind: "added" | "removed" | "changed"; fromParagraphId?: string; toParagraphId?: string }>;
  provenance: FactProvenance;
  quality: FactQuality;
}

export interface ResearchCalendarEventFact {
  id: string;
  kind: "calendar_event";
  subjectId: string;
  eventType: "corporate_action" | "earnings_release" | "macro_release";
  scheduledFor: string;
  status: "tentative" | "confirmed" | "completed" | "cancelled";
  precision: "date" | "datetime";
  provenance: FactProvenance;
  quality: FactQuality;
}

export type ResearchFact =
  | InstrumentMappingFact
  | MarketBaselineFact
  | FinancialMetricFact
  | ValuationFact
  | DocumentParagraphFact
  | DocumentVersionDiffFact
  | ResearchCalendarEventFact;

export interface ResearchCapabilityOutcome {
  id: ResearchCapabilityId;
  required: boolean;
  status: ResearchCapabilityStatus;
  factIds: string[];
  asOf: string | null;
  retrievedAt: string;
  warnings: string[];
  limitations: ResearchCapabilityLimitation[];
  error?: { code: string; retryable: boolean };
}

export interface ResearchFactBundle {
  schemaVersion: typeof RESEARCH_FACT_SCHEMA_VERSION;
  planVersion: string;
  purpose: ResearchPurpose;
  observationCutoff: string;
  /** Optional only so immutable research-facts.v2 checkpoints remain replayable. */
  expectedLatestSessionDate?: string;
  knowledgeCutoff: string;
  generatedAt: string;
  instrumentIds: string[];
  facts: ResearchFact[];
  capabilities: ResearchCapabilityOutcome[];
  fingerprint: `sha256:${string}`;
}

export interface ResearchFactPlane {
  materialize(request: ResearchFactRequest): Promise<ResearchFactBundle>;
}

const RESEARCH_PURPOSES: readonly ResearchPurpose[] = [
  "price_context",
  "relative_performance",
  "company_update",
  "company_research",
  "event_calendar",
];

const BASELINE_WINDOWS: readonly MarketBaselineWindow[] = [20, 60, 250];
const BASELINE_TYPES: readonly MarketBaselineType[] = ["price_return", "volume_median", "realized_volatility", "relative_return"];
const CAPABILITY_IDS: readonly ResearchCapabilityId[] = ["instrument_mapping", "market_baselines", "fundamentals", "valuation", "documents", "calendar"];
const BASELINE_OPERATOR_CONTRACT: Record<MarketBaselineType, { expression: string; unit: MarketBaselineFact["value"]["unit"] }> = {
  price_return: { expression: "close[t] / close[t-window] - 1", unit: "ratio" },
  volume_median: { expression: "median(volume[t-window+1..t])", unit: "shares" },
  realized_volatility: { expression: "sample_stddev(ln(close[t]/close[t-1])) * sqrt(250)", unit: "ratio" },
  relative_return: { expression: "subject_return - benchmark_return", unit: "ratio" },
};

export function validateResearchFactRequest(value: unknown): ResearchFactValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["request must be an object"] };
  exactKeys(value, ["purpose", "instrumentIds", "selectedInstrumentId", "observationCutoff", "expectedLatestSessionDate"], "request", issues);
  if (typeof value.purpose !== "string" || !RESEARCH_PURPOSES.includes(value.purpose as ResearchPurpose)) issues.push("purpose is invalid");
  const instrumentIds = validateInstrumentIds(value.instrumentIds, "instrumentIds", issues);
  if (!isIso(value.observationCutoff)) issues.push("observationCutoff must be an ISO timestamp");
  if (value.expectedLatestSessionDate !== undefined && !isDate(value.expectedLatestSessionDate)) issues.push("expectedLatestSessionDate must be YYYY-MM-DD");
  if (value.selectedInstrumentId !== undefined) {
    if (!isInstrumentId(value.selectedInstrumentId)) issues.push("selectedInstrumentId is invalid");
    else if (!instrumentIds.includes(value.selectedInstrumentId)) issues.push("selectedInstrumentId must belong to instrumentIds");
  }
  return { ok: issues.length === 0, issues };
}

export function parseResearchFactRequest(value: unknown): ResearchFactRequest {
  const validation = validateResearchFactRequest(value);
  if (!validation.ok) throw new Error(`Invalid ResearchFactRequest: ${validation.issues.join("; ")}`);
  return value as ResearchFactRequest;
}

export function validateResearchFactBundle(value: unknown): ResearchFactValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["bundle must be an object"] };
  exactKeys(value, ["schemaVersion", "planVersion", "purpose", "observationCutoff", "expectedLatestSessionDate", "knowledgeCutoff", "generatedAt", "instrumentIds", "facts", "capabilities", "fingerprint"], "bundle", issues);
  if (value.schemaVersion !== RESEARCH_FACT_SCHEMA_VERSION) issues.push("schemaVersion must be research-facts.v2");
  requireString(value.planVersion, "planVersion", issues);
  if (typeof value.purpose !== "string" || !RESEARCH_PURPOSES.includes(value.purpose as ResearchPurpose)) issues.push("purpose is invalid");
  if (!isIso(value.observationCutoff)) issues.push("observationCutoff must be an ISO timestamp");
  if (value.expectedLatestSessionDate !== undefined && !isDate(value.expectedLatestSessionDate)) issues.push("expectedLatestSessionDate must be YYYY-MM-DD");
  if (!isIso(value.knowledgeCutoff)) issues.push("knowledgeCutoff must be an ISO timestamp");
  if (!isIso(value.generatedAt)) issues.push("generatedAt must be an ISO timestamp");
  if (isIso(value.observationCutoff) && isIso(value.knowledgeCutoff) && Date.parse(value.observationCutoff) > Date.parse(value.knowledgeCutoff)) issues.push("observationCutoff cannot exceed knowledgeCutoff");
  if (isIso(value.knowledgeCutoff) && isIso(value.generatedAt) && Date.parse(value.knowledgeCutoff) > Date.parse(value.generatedAt)) issues.push("knowledgeCutoff cannot exceed generatedAt");
  const instrumentIds = validateInstrumentIds(value.instrumentIds, "instrumentIds", issues);
  if (!isFingerprint(value.fingerprint)) issues.push("fingerprint must be sha256");

  const facts = validateFacts(value.facts, instrumentIds, value.observationCutoff, value.knowledgeCutoff, issues);
  const expectedLatestSessionDate = isDate(value.expectedLatestSessionDate) ? value.expectedLatestSessionDate : undefined;
  const capabilities = validateCapabilities(value.capabilities, facts, value.observationCutoff, value.knowledgeCutoff, expectedLatestSessionDate, issues);
  if (value.purpose === "price_context") {
    if (value.planVersion !== "price-context.v1") issues.push("price_context requires planVersion price-context.v1");
    validateBaselineSlice(instrumentIds, facts, capabilities, false, expectedLatestSessionDate, issues);
  } else if (value.purpose === "relative_performance") {
    if (value.planVersion !== "relative-performance.v1") issues.push("relative_performance requires planVersion relative-performance.v1");
    validateBaselineSlice(instrumentIds, facts, capabilities, true, expectedLatestSessionDate, issues);
  }
  return { ok: issues.length === 0, issues };
}

export function parseResearchFactBundle(value: unknown): ResearchFactBundle {
  const validation = validateResearchFactBundle(value);
  if (!validation.ok) throw new Error(`Invalid ResearchFactBundle: ${validation.issues.join("; ")}`);
  return value as ResearchFactBundle;
}

export async function calculateResearchFactBundleFingerprint(value: Omit<ResearchFactBundle, "fingerprint"> | ResearchFactBundle): Promise<`sha256:${string}`> {
  const { fingerprint: _fingerprint, ...payload } = value as ResearchFactBundle;
  const canonical = stableJson(canonicalBundle(payload));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyResearchFactBundleFingerprint(value: ResearchFactBundle): Promise<boolean> {
  return timingSafeEqual(value.fingerprint, await calculateResearchFactBundleFingerprint(value));
}

function validateFacts(value: unknown, instrumentIds: string[], observationCutoff: unknown, knowledgeCutoff: unknown, issues: string[]): ResearchFact[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    issues.push("facts must be an array with at most 1000 items");
    return [];
  }
  const facts: ResearchFact[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const path = `facts[${index}]`;
    if (!isRecord(item)) { issues.push(`${path} must be an object`); return; }
    requireString(item.id, `${path}.id`, issues);
    if (typeof item.id === "string") {
      if (ids.has(item.id)) issues.push(`${path}.id must be unique`);
      ids.add(item.id);
    }
    if (!isInstrumentId(item.subjectId)) issues.push(`${path}.subjectId is invalid`);
    else if (!instrumentIds.includes(item.subjectId) && item.kind !== "calendar_event") issues.push(`${path}.subjectId is outside instrumentIds`);
    validateProvenance(item.provenance, `${path}.provenance`, observationCutoff, knowledgeCutoff, issues);
    validateFactQuality(item.quality, `${path}.quality`, issues);
    if (item.kind === "instrument_mapping") validateMappingFact(item, path, issues);
    else if (item.kind === "market_baseline") validateBaselineFact(item, path, issues);
    else if (item.kind === "financial_metric") validateFinancialMetricFact(item, path, issues);
    else if (item.kind === "valuation") validateValuationFact(item, path, issues);
    else if (item.kind === "document_paragraph") validateDocumentParagraphFact(item, path, issues);
    else if (item.kind === "document_version_diff") validateDocumentDiffFact(item, path, issues);
    else if (item.kind === "calendar_event") validateCalendarEventFact(item, path, issues);
    else issues.push(`${path}.kind is invalid`);
    facts.push(item as unknown as ResearchFact);
  });
  return facts;
}

function validateMappingFact(value: Record<string, unknown>, path: string, issues: string[]) {
  if (!oneOf(value.mappingType, ["benchmark", "industry", "index_membership"])) issues.push(`${path}.mappingType is invalid`);
  requireString(value.targetId, `${path}.targetId`, issues);
  if (!isIso(value.validFrom)) issues.push(`${path}.validFrom must be an ISO timestamp`);
  if (value.validTo !== null && !isIso(value.validTo)) issues.push(`${path}.validTo must be null or an ISO timestamp`);
  if (isIso(value.validFrom) && isIso(value.validTo) && Date.parse(value.validTo) <= Date.parse(value.validFrom)) issues.push(`${path}.validTo must be after validFrom`);
  requireString(value.methodologyVersion, `${path}.methodologyVersion`, issues);
  if (value.weight !== undefined) validateDecimalValue(value.weight, `${path}.weight`, ["ratio"], issues);
}

function validateBaselineFact(value: Record<string, unknown>, path: string, issues: string[]) {
  if (!oneOf(value.baselineType, BASELINE_TYPES)) issues.push(`${path}.baselineType is invalid`);
  if (!BASELINE_WINDOWS.includes(value.window as MarketBaselineWindow)) issues.push(`${path}.window must be 20, 60, or 250`);
  if (value.baselineType === "relative_return") {
    if (!isInstrumentId(value.benchmarkId)) issues.push(`${path}.benchmarkId is required for relative_return`);
  } else if (value.benchmarkId !== undefined) issues.push(`${path}.benchmarkId is only allowed for relative_return`);
  if (!isRecord(value.observationPeriod)) issues.push(`${path}.observationPeriod must be an object`);
  else {
    if (!isIso(value.observationPeriod.start)) issues.push(`${path}.observationPeriod.start must be an ISO timestamp`);
    if (!isIso(value.observationPeriod.end)) issues.push(`${path}.observationPeriod.end must be an ISO timestamp`);
    if (value.observationPeriod.tradingSessions !== value.window) issues.push(`${path}.observationPeriod.tradingSessions must equal window`);
  }
  validateDecimalValue(value.value, `${path}.value`, value.baselineType === "volume_median" ? ["shares"] : ["ratio"], issues);
  validateFormula(value.formula, `${path}.formula`, issues);
  if (oneOf(value.baselineType, BASELINE_TYPES) && BASELINE_WINDOWS.includes(value.window as MarketBaselineWindow)) {
    validateBaselineOperator(value as unknown as MarketBaselineFact, path, issues);
  }
  if (isRecord(value.formula) && Array.isArray(value.formula.inputArtifactIds) && isRecord(value.provenance) && Array.isArray(value.provenance.sourceArtifactIds)) {
    const provenanceArtifacts = new Set(value.provenance.sourceArtifactIds.filter((item): item is string => typeof item === "string"));
    for (const inputArtifactId of value.formula.inputArtifactIds) {
      if (typeof inputArtifactId === "string" && !provenanceArtifacts.has(inputArtifactId)) issues.push(`${path}.formula input ${inputArtifactId} is absent from provenance`);
    }
  }
  if (isRecord(value.quality) && isRecord(value.quality.coverage) && typeof value.window === "number") {
    const required = value.baselineType === "volume_median" ? value.window : value.window + 1;
    if (value.quality.coverage.required !== required) issues.push(`${path}.quality.coverage.required must be ${required}`);
  }
}

function validateBaselineOperator(value: MarketBaselineFact, path: string, issues: string[]) {
  const contract = BASELINE_OPERATOR_CONTRACT[value.baselineType];
  const formula = value.formula;
  if (!isRecord(formula)) return;
  if (formula.id !== `market.${value.baselineType}.v1`) issues.push(`${path}.formula.id must be market.${value.baselineType}.v1`);
  if (formula.version !== "1") issues.push(`${path}.formula.version must be 1`);
  if (formula.expression !== contract.expression) issues.push(`${path}.formula.expression does not match ${value.baselineType}`);
  if (formula.rounding !== "decimal-12-nearest") issues.push(`${path}.formula.rounding must be decimal-12-nearest`);
  if (isRecord(formula.parameters)) {
    exactKeys(formula.parameters, ["window", "annualizationSessions", "adjustment"], `${path}.formula.parameters`, issues);
    if (formula.parameters.window !== String(value.window)) issues.push(`${path}.formula.parameters.window must equal fact.window`);
    if (formula.parameters.annualizationSessions !== "250") issues.push(`${path}.formula.parameters.annualizationSessions must be 250`);
    if (formula.parameters.adjustment !== "qfq") issues.push(`${path}.formula.parameters.adjustment must be qfq`);
  }
  if (value.value.unit !== contract.unit) issues.push(`${path}.value.unit must be ${contract.unit} for ${value.baselineType}`);
}

function validateFinancialMetricFact(value: Record<string, unknown>, path: string, issues: string[]) {
  requireString(value.metric, `${path}.metric`, issues);
  if (!isRecord(value.period)) issues.push(`${path}.period must be an object`);
  else {
    if (!isIso(value.period.start) || !isIso(value.period.end)) issues.push(`${path}.period must have ISO start and end`);
    if (!oneOf(value.period.basis, ["quarter", "year_to_date", "fiscal_year"])) issues.push(`${path}.period.basis is invalid`);
  }
  validateDecimalValue(value.value, `${path}.value`, ["CNY", "ratio", "shares"], issues);
  if (value.comparison !== undefined) {
    if (!isRecord(value.comparison)) issues.push(`${path}.comparison must be an object`);
    else {
      if (!oneOf(value.comparison.kind, ["yoy", "qoq"])) issues.push(`${path}.comparison.kind is invalid`);
      if (!isDecimal(value.comparison.decimal)) issues.push(`${path}.comparison.decimal is invalid`);
      if (value.comparison.unit !== "ratio") issues.push(`${path}.comparison.unit must be ratio`);
      validateFormula(value.comparison.formula, `${path}.comparison.formula`, issues);
    }
  }
}

function validateValuationFact(value: Record<string, unknown>, path: string, issues: string[]) {
  if (!oneOf(value.metric, ["pe_ttm", "pb", "ps_ttm", "dividend_yield"])) issues.push(`${path}.metric is invalid`);
  validateDecimalValue(value.value, `${path}.value`, ["ratio"], issues);
  if (value.historicalPercentile !== undefined) {
    if (!isRecord(value.historicalPercentile)) issues.push(`${path}.historicalPercentile must be an object`);
    else {
      if (!isDecimal(value.historicalPercentile.decimal)) issues.push(`${path}.historicalPercentile.decimal is invalid`);
      if (value.historicalPercentile.unit !== "ratio") issues.push(`${path}.historicalPercentile.unit must be ratio`);
      validateFormula(value.historicalPercentile.formula, `${path}.historicalPercentile.formula`, issues);
    }
  }
}

function validateDocumentParagraphFact(value: Record<string, unknown>, path: string, issues: string[]) {
  for (const field of ["documentId", "versionId", "paragraphId", "text"] as const) requireString(value[field], `${path}.${field}`, issues);
  if (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0) issues.push(`${path}.ordinal is invalid`);
  if (!isFingerprint(value.contentDigest)) issues.push(`${path}.contentDigest must be sha256`);
}

function validateDocumentDiffFact(value: Record<string, unknown>, path: string, issues: string[]) {
  for (const field of ["documentId", "fromVersionId", "toVersionId"] as const) requireString(value[field], `${path}.${field}`, issues);
  if (!isRecord(value.algorithm) || value.algorithm.id !== "paragraph-diff" || typeof value.algorithm.version !== "string") issues.push(`${path}.algorithm is invalid`);
  if (!Array.isArray(value.changes)) issues.push(`${path}.changes must be an array`);
}

function validateCalendarEventFact(value: Record<string, unknown>, path: string, issues: string[]) {
  if (!oneOf(value.eventType, ["corporate_action", "earnings_release", "macro_release"])) issues.push(`${path}.eventType is invalid`);
  if (!isIso(value.scheduledFor)) issues.push(`${path}.scheduledFor must be an ISO timestamp`);
  if (!oneOf(value.status, ["tentative", "confirmed", "completed", "cancelled"])) issues.push(`${path}.status is invalid`);
  if (!oneOf(value.precision, ["date", "datetime"])) issues.push(`${path}.precision is invalid`);
}

function validateProvenance(value: unknown, path: string, observationCutoff: unknown, knowledgeCutoff: unknown, issues: string[]) {
  if (!isRecord(value)) { issues.push(`${path} must be an object`); return; }
  nonEmptyStringArray(value.providers, `${path}.providers`, issues);
  nonEmptyStringArray(value.sourceArtifactIds, `${path}.sourceArtifactIds`, issues);
  if (!isIso(value.sourceAsOf)) issues.push(`${path}.sourceAsOf must be an ISO timestamp`);
  if (!isIso(value.retrievedAt)) issues.push(`${path}.retrievedAt must be an ISO timestamp`);
  if (isIso(value.sourceAsOf) && isIso(observationCutoff) && Date.parse(value.sourceAsOf) > Date.parse(observationCutoff)) issues.push(`${path}.sourceAsOf cannot exceed observationCutoff`);
  if (isIso(value.retrievedAt) && isIso(knowledgeCutoff) && Date.parse(value.retrievedAt) > Date.parse(knowledgeCutoff)) issues.push(`${path}.retrievedAt cannot exceed knowledgeCutoff`);
}

function validateFactQuality(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) { issues.push(`${path} must be an object`); return; }
  if (!oneOf(value.status, ["operational", "degraded"])) issues.push(`${path}.status is invalid`);
  if (typeof value.reliable !== "boolean") issues.push(`${path}.reliable must be boolean`);
  if (!isRecord(value.coverage) || !nonNegativeInteger(value.coverage.actual) || !positiveInteger(value.coverage.required)) issues.push(`${path}.coverage is invalid`);
  else if (value.reliable === true && value.coverage.actual < value.coverage.required) issues.push(`${path}.reliable quality requires complete coverage`);
  if (value.status === "degraded" && value.reliable === true) issues.push(`${path}.degraded quality cannot be reliable`);
  stringArray(value.warnings, `${path}.warnings`, issues);
}

function validateFormula(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) { issues.push(`${path} must be an object`); return; }
  for (const field of ["id", "version", "expression", "rounding"] as const) requireString(value[field], `${path}.${field}`, issues);
  nonEmptyStringArray(value.inputArtifactIds, `${path}.inputArtifactIds`, issues);
  if (!isRecord(value.parameters) || Object.values(value.parameters).some((item) => typeof item !== "string")) issues.push(`${path}.parameters must be string values`);
}

function validateDecimalValue(value: unknown, path: string, units: readonly string[], issues: string[]) {
  if (!isRecord(value)) { issues.push(`${path} must be an object`); return; }
  if (!isDecimal(value.decimal)) issues.push(`${path}.decimal is invalid`);
  if (typeof value.unit !== "string" || !units.includes(value.unit)) issues.push(`${path}.unit is invalid`);
}

function validateCapabilities(value: unknown, facts: ResearchFact[], observationCutoff: unknown, knowledgeCutoff: unknown, expectedLatestSessionDate: string | undefined, issues: string[]): ResearchCapabilityOutcome[] {
  if (!Array.isArray(value)) { issues.push("capabilities must be an array"); return []; }
  const factIds = new Set(facts.map((fact) => fact.id));
  const ids = new Set<string>();
  const capabilities: ResearchCapabilityOutcome[] = [];
  value.forEach((item, index) => {
    const path = `capabilities[${index}]`;
    if (!isRecord(item)) { issues.push(`${path} must be an object`); return; }
    if (typeof item.id !== "string" || !CAPABILITY_IDS.includes(item.id as ResearchCapabilityId)) issues.push(`${path}.id is invalid`);
    else if (ids.has(item.id)) issues.push(`${path}.id must be unique`);
    else ids.add(item.id);
    if (typeof item.required !== "boolean") issues.push(`${path}.required must be boolean`);
    if (!oneOf(item.status, ["operational", "degraded", "unavailable"])) issues.push(`${path}.status is invalid`);
    if (!Array.isArray(item.factIds) || item.factIds.some((factId) => typeof factId !== "string")) issues.push(`${path}.factIds must be string[]`);
    else for (const factId of item.factIds) if (!factIds.has(factId)) issues.push(`${path} references unknown fact ${factId}`);
    if (item.status === "unavailable") {
      if (Array.isArray(item.factIds) && item.factIds.length) issues.push(`${path}.unavailable capability cannot reference facts`);
      if (item.asOf !== null) issues.push(`${path}.unavailable capability requires asOf null`);
      if (!isRecord(item.error) || typeof item.error.code !== "string" || typeof item.error.retryable !== "boolean") issues.push(`${path}.unavailable capability requires an error`);
    } else {
      if (!isIso(item.asOf)) issues.push(`${path}.asOf must be an ISO timestamp`);
      if (Array.isArray(item.factIds) && !item.factIds.length) issues.push(`${path}.${item.status} capability requires facts`);
    }
    if (!isIso(item.retrievedAt)) issues.push(`${path}.retrievedAt must be an ISO timestamp`);
    if (isIso(item.asOf) && isIso(observationCutoff) && Date.parse(item.asOf) > Date.parse(observationCutoff)) issues.push(`${path}.asOf cannot exceed observationCutoff`);
    if (isIso(item.retrievedAt) && isIso(knowledgeCutoff) && Date.parse(item.retrievedAt) > Date.parse(knowledgeCutoff)) issues.push(`${path}.retrievedAt cannot exceed knowledgeCutoff`);
    stringArray(item.warnings, `${path}.warnings`, issues);
    const limitations = validateCapabilityLimitations(item.limitations, `${path}.limitations`, issues);
    if (item.id === "market_baselines") {
      for (const limitation of limitations) {
        if (limitation.code === "LATEST_SESSION_MISSING" && limitation.expectedSessionDate !== expectedLatestSessionDate) issues.push(`${path}.LATEST_SESSION_MISSING expectedSessionDate must equal bundle.expectedLatestSessionDate`);
      }
    }
    if (item.status === "operational" && limitations.length > 0) issues.push(`${path}.operational capability cannot have limitations`);
    if ((item.status === "degraded" || item.status === "unavailable") && limitations.length === 0) issues.push(`${path}.${item.status} capability requires structured limitations`);
    capabilities.push(item as unknown as ResearchCapabilityOutcome);
  });
  return capabilities;
}

function validateCapabilityLimitations(value: unknown, path: string, issues: string[]): ResearchCapabilityLimitation[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const limitations: ResearchCapabilityLimitation[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) { issues.push(`${itemPath} must be an object`); return; }
    exactKeys(item, ["code", "subjectId", "baselineType", "window", "actual", "required", "expectedSessionDate", "actualSessionDate", "retryable"], itemPath, issues);
    requireString(item.code, `${itemPath}.code`, issues);
    if (item.subjectId !== undefined && !isInstrumentId(item.subjectId)) issues.push(`${itemPath}.subjectId is invalid`);
    if (item.baselineType !== undefined && !oneOf(item.baselineType, BASELINE_TYPES)) issues.push(`${itemPath}.baselineType is invalid`);
    if (item.window !== undefined && !BASELINE_WINDOWS.includes(item.window as MarketBaselineWindow)) issues.push(`${itemPath}.window must be 20, 60, or 250`);
    if (item.actual !== undefined && !nonNegativeInteger(item.actual)) issues.push(`${itemPath}.actual must be a non-negative integer`);
    if (item.required !== undefined && !positiveInteger(item.required)) issues.push(`${itemPath}.required must be a positive integer`);
    if ((item.actual === undefined) !== (item.required === undefined)) issues.push(`${itemPath}.actual and required must be provided together`);
    if (item.expectedSessionDate !== undefined && !isDate(item.expectedSessionDate)) issues.push(`${itemPath}.expectedSessionDate must be YYYY-MM-DD`);
    if (item.actualSessionDate !== undefined && !isDate(item.actualSessionDate)) issues.push(`${itemPath}.actualSessionDate must be YYYY-MM-DD`);
    if (typeof item.retryable !== "boolean") issues.push(`${itemPath}.retryable must be boolean`);
    if (item.code === "INSUFFICIENT_SAMPLE" && (
      !isInstrumentId(item.subjectId)
      || !oneOf(item.baselineType, BASELINE_TYPES)
      || !BASELINE_WINDOWS.includes(item.window as MarketBaselineWindow)
      || !nonNegativeInteger(item.actual)
      || !positiveInteger(item.required)
      || item.actual >= item.required
    )) issues.push(`${itemPath}.INSUFFICIENT_SAMPLE requires subjectId, baselineType, window, actual, and required with actual below required`);
    if (item.code === "LATEST_SESSION_MISSING" && (
      !isInstrumentId(item.subjectId)
      || !isDate(item.expectedSessionDate)
      || !isDate(item.actualSessionDate)
      || item.actualSessionDate >= item.expectedSessionDate
      || item.retryable !== false
    )) issues.push(`${itemPath}.LATEST_SESSION_MISSING requires expectedSessionDate after actualSessionDate`);
    limitations.push(item as unknown as ResearchCapabilityLimitation);
  });
  return limitations;
}

function validateBaselineSlice(instrumentIds: string[], facts: ResearchFact[], capabilities: ResearchCapabilityOutcome[], relative: boolean, expectedLatestSessionDate: string | undefined, issues: string[]) {
  const expectedByCapability: Record<"instrument_mapping" | "market_baselines", string[]> = {
    instrument_mapping: facts.filter((fact) => fact.kind === "instrument_mapping").map((fact) => fact.id),
    market_baselines: facts.filter((fact) => fact.kind === "market_baseline").map((fact) => fact.id),
  };
  const requiredCapabilities = relative ? ["instrument_mapping", "market_baselines"] as const : ["market_baselines"] as const;
  for (const capabilityId of requiredCapabilities) {
    const capability = capabilities.find((item) => item.id === capabilityId);
    if (!capability) issues.push(`missing required capability ${capabilityId}`);
    else {
      if (!capability.required) issues.push(`${capabilityId} must be required`);
      if (!sameStringSet(capability.factIds, expectedByCapability[capabilityId])) issues.push(`${capabilityId} factIds must exactly cover ${capabilityId === "instrument_mapping" ? "instrument_mapping" : "market_baseline"} facts`);
    }
  }
  const mappingCapability = capabilities.find((item) => item.id === "instrument_mapping");
  const baselineCapability = capabilities.find((item) => item.id === "market_baselines");
  if (expectedLatestSessionDate && baselineCapability?.status === "operational") {
    const missesExpectedSession = facts.some((fact) => fact.kind === "market_baseline" && baselineEndDate(fact) !== expectedLatestSessionDate);
    if (missesExpectedSession) issues.push(`operational market_baselines must end on expectedLatestSessionDate ${expectedLatestSessionDate}`);
  }
  if (expectedLatestSessionDate && baselineCapability) {
    const latestSessionLimitations = baselineCapability.limitations.filter((limitation) => limitation.code === "LATEST_SESSION_MISSING");
    for (const fact of facts) {
      if (fact.kind !== "market_baseline") continue;
      const endDate = baselineEndDate(fact);
      if (!endDate) continue;
      if (endDate > expectedLatestSessionDate) {
        issues.push(`${fact.id}.observationPeriod.end cannot exceed expectedLatestSessionDate ${expectedLatestSessionDate}`);
        continue;
      }
      if (endDate === expectedLatestSessionDate) continue;
      const matchingLimitation = latestSessionLimitations.some((limitation) => (
        limitation.subjectId === fact.subjectId
        && (limitation.baselineType === undefined || limitation.baselineType === fact.baselineType)
        && limitation.actualSessionDate === endDate
      ));
      if (!matchingLimitation) issues.push(`${fact.id} requires a matching LATEST_SESSION_MISSING limitation`);
      if (fact.quality.status !== "degraded" || fact.quality.reliable || !fact.quality.warnings.includes("LATEST_SESSION_MISSING")) {
        issues.push(`${fact.id} lagged market_baseline fact must be degraded, unreliable, and warning-bound`);
      }
    }
  }
  for (const instrumentId of instrumentIds) {
    const mappings = facts.filter((fact): fact is InstrumentMappingFact => fact.kind === "instrument_mapping" && fact.subjectId === instrumentId && fact.mappingType === "benchmark");
    if (mappings.length > 1 || (relative && mappingCapability?.status === "operational" && mappings.length !== 1)) issues.push(`${instrumentId} requires exactly one benchmark mapping when instrument_mapping is operational`);
    const requiredTypes = relative ? BASELINE_TYPES : BASELINE_TYPES.filter((type) => type !== "relative_return");
    for (const baselineType of requiredTypes) for (const window of BASELINE_WINDOWS) {
      const matches = facts.filter((fact): fact is MarketBaselineFact => fact.kind === "market_baseline" && fact.subjectId === instrumentId && fact.baselineType === baselineType && fact.window === window);
      if (matches.length === 0 && baselineCapability?.status === "operational") issues.push(`${instrumentId} missing ${baselineType}:${window}`);
      else if (matches.length > 1) issues.push(`${instrumentId} has duplicate ${baselineType}:${window}`);
      else if (matches.length === 1 && baselineType === "relative_return" && mappings[0] && matches[0].benchmarkId !== mappings[0].targetId) issues.push(`${matches[0].id}.benchmarkId must match the effective benchmark mapping`);
    }
  }
}

function baselineEndDate(fact: MarketBaselineFact): string | null {
  const period = fact.observationPeriod as unknown;
  return isRecord(period) && typeof period.end === "string" ? period.end.slice(0, 10) : null;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return new Set(left).size === left.length && left.every((item) => expected.has(item));
}

function canonicalBundle(bundle: Omit<ResearchFactBundle, "fingerprint">) {
  return {
    ...bundle,
    instrumentIds: [...bundle.instrumentIds].sort(),
    facts: [...bundle.facts].map(canonicalFact).sort((left, right) => left.id.localeCompare(right.id)),
    capabilities: [...bundle.capabilities].map((capability) => ({
      ...capability,
      factIds: [...capability.factIds].sort(),
      warnings: [...capability.warnings].sort(),
      limitations: [...capability.limitations].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function canonicalFact(fact: ResearchFact): ResearchFact {
  return {
    ...fact,
    provenance: { ...fact.provenance, providers: [...fact.provenance.providers].sort(), sourceArtifactIds: [...fact.provenance.sourceArtifactIds].sort() },
    quality: { ...fact.quality, warnings: [...fact.quality.warnings].sort() },
    ...(fact.kind === "market_baseline" ? { formula: { ...fact.formula, inputArtifactIds: [...fact.formula.inputArtifactIds].sort() } } : {}),
  } as ResearchFact;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${path}.${key} is not allowed`);
}

function requireString(value: unknown, path: string, issues: string[]) {
  if (typeof value !== "string" || value.length === 0) issues.push(`${path} must be a non-empty string`);
}

function stringArray(value: unknown, path: string, issues: string[]) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) issues.push(`${path} must be string[]`);
}

function nonEmptyStringArray(value: unknown, path: string, issues: string[]) {
  stringArray(value, path, issues);
  if (Array.isArray(value) && value.length === 0) issues.push(`${path} must not be empty`);
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && !Object.is(Number(value), -0);
}

function isFingerprint(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateInstrumentIds(value: unknown, path: string, issues: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    issues.push(`${path} must contain 1 to 20 instruments`);
    return [];
  }
  const result = value.filter((item): item is string => typeof item === "string");
  if (result.length !== value.length || result.some((item) => !isInstrumentId(item))) issues.push(`${path} contains an invalid instrument`);
  if (new Set(result).size !== result.length) issues.push(`${path} must not contain duplicates`);
  if (!isSorted(result)) issues.push(`${path} must use canonical sort order`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInstrumentId(value: unknown): value is string {
  return typeof value === "string" && /^(SSE|SZSE):\d{6}$/.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isDate(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}
