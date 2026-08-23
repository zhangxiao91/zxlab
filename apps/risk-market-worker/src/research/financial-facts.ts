import type {
  DeterministicFormula,
  FinancialMetricComparison,
  FinancialMetricFact,
  FinancialMetricId,
  FinancialReportingPeriod,
  ResearchCapabilityLimitation,
  ResearchCapabilityOutcome,
} from "@zxlab/research-fact-schema";
import type {
  FinancialStatementProjection,
  OfficialFilingProjection,
  ResearchArtifact,
  ResearchArtifactSnapshot,
} from "./artifact-store.ts";
import { deriveStandaloneQuarter, financialRatioChange } from "./financial-statements.ts";

const FLOW_METRICS: FinancialMetricId[] = [
  "operating_revenue",
  "operating_profit",
  "net_profit_attributable_to_parent",
  "net_cash_flow_from_operating_activities",
];
const METRICS: FinancialMetricId[] = [...FLOW_METRICS, "total_assets"];

interface CellValue {
  metric: FinancialMetricId;
  value: string;
  period: FinancialReportingPeriod;
  artifacts: ResearchArtifact[];
  formula?: DeterministicFormula;
}

export function buildCompanyUpdateFacts(input: {
  snapshot: ResearchArtifactSnapshot;
  instrumentIds: string[];
  initialLimitations?: ResearchCapabilityLimitation[];
  retrievedAt: string;
}): { facts: FinancialMetricFact[]; capability: ResearchCapabilityOutcome } {
  const limitations = [...(input.initialLimitations ?? [])];
  const facts: FinancialMetricFact[] = [];
  for (const instrumentId of input.instrumentIds) {
    const artifacts = input.snapshot.artifacts.filter((artifact) => artifact.subjectId === instrumentId);
    const values = financialValues(artifacts);
    const latestEnd = [...values.values()].map((value) => value.period.end).sort().at(-1);
    if (!latestEnd) {
      limitations.push({ code: "FINANCIAL_ARTIFACT_UNAVAILABLE", subjectId: instrumentId, retryable: true });
      continue;
    }
    for (const metric of METRICS) {
      const current = values.get(cellKey(metric, latestEnd));
      if (!current) {
        limitations.push({ code: "FINANCIAL_METRIC_MISSING", subjectId: instrumentId, metric, periodEnd: latestEnd.slice(0, 10), retryable: false });
        continue;
      }
      if (metric === "total_assets") {
        const stock = { ...current, period: stockPeriod(current.period.end) };
        const compared = comparisonsFor(stock, [
          ["yoy", asStockValue(values.get(cellKey(metric, yearAgo(latestEnd))))],
          ["qoq", asStockValue(values.get(cellKey(metric, previousQuarterEnd(latestEnd))))],
        ], limitations, instrumentId);
        facts.push(financialFact(instrumentId, stock, "reported", compared, limitations));
        continue;
      }
      const reportedComparisons = comparisonsFor(current, [["yoy", values.get(cellKey(metric, yearAgo(latestEnd)))]], limitations, instrumentId);
      facts.push(financialFact(instrumentId, current, "reported", reportedComparisons, limitations));
      if (current.period.basis === "quarter") continue;
      const quarter = standaloneQuarter(current, values, limitations, instrumentId);
      if (!quarter) continue;
      const priorYear = standaloneQuarterFor(metric, yearAgo(latestEnd), values);
      const priorQuarter = standaloneQuarterFor(metric, previousQuarterEnd(latestEnd), values);
      const comparisons = comparisonsFor(quarter, [["yoy", priorYear], ["qoq", priorQuarter]], limitations, instrumentId);
      facts.push(financialFact(instrumentId, quarter, "standalone-quarter", comparisons, limitations));
    }
  }
  facts.sort((left, right) => left.subjectId.localeCompare(right.subjectId) || left.metric.localeCompare(right.metric) || left.period.end.localeCompare(right.period.end) || left.period.basis.localeCompare(right.period.basis));
  const degraded = limitations.length > 0 || facts.some((fact) => fact.quality.status === "degraded");
  const capability: ResearchCapabilityOutcome = facts.length
    ? {
      id: "fundamentals",
      required: true,
      status: degraded ? "degraded" : "operational",
      factIds: facts.map((fact) => fact.id).sort(),
      asOf: latest(facts.map((fact) => fact.provenance.sourceAsOf)),
      retrievedAt: latest(facts.map((fact) => fact.provenance.retrievedAt)) ?? input.retrievedAt,
      warnings: [...new Set(limitations.map((limitation) => limitation.code).concat(facts.flatMap((fact) => fact.quality.warnings)))].sort(),
      limitations: dedupeLimitations(limitations),
    }
    : {
      id: "fundamentals",
      required: true,
      status: "unavailable",
      factIds: [],
      asOf: null,
      retrievedAt: input.retrievedAt,
      warnings: [...new Set(limitations.map((limitation) => limitation.code))].sort(),
      limitations: dedupeLimitations(limitations.length ? limitations : [{ code: "FINANCIAL_ARTIFACT_UNAVAILABLE", retryable: true }]),
      error: { code: limitations[0]?.code ?? "FINANCIAL_ARTIFACT_UNAVAILABLE", retryable: limitations.some((limitation) => limitation.retryable) || !limitations.length },
    };
  return { facts, capability };
}

function financialValues(artifacts: ResearchArtifact[]): Map<string, CellValue> {
  const result = new Map<string, CellValue>();
  const filings = new Map(artifacts.filter((artifact) => artifact.kind === "official_filing_identity.v1").map((artifact) => [artifact.logicalKey, artifact] as const));
  for (const artifact of artifacts) {
    if (artifact.kind !== "financial_statement.v1" || !artifact.projection || !("statementType" in artifact.projection)) continue;
    const projection = artifact.projection as FinancialStatementProjection;
    const filingKey = isRecord(artifact.payload) && typeof artifact.payload.officialFilingLogicalKey === "string" ? artifact.payload.officialFilingLogicalKey : null;
    const official = filingKey ? filings.get(filingKey) : undefined;
    const inputs = official ? [artifact, official] : [{ ...artifact, warnings: [...new Set([...artifact.warnings, "OFFICIAL_FILING_UNCORROBORATED"])] }];
    for (const cell of projection.cells) {
      if (!METRICS.includes(cell.metric as FinancialMetricId)) continue;
      result.set(cellKey(cell.metric as FinancialMetricId, projection.reportPeriod.end), {
        metric: cell.metric as FinancialMetricId,
        value: cell.value,
        period: projection.reportPeriod,
        artifacts: inputs,
      });
    }
  }
  return result;
}

function standaloneQuarter(current: CellValue, values: Map<string, CellValue>, limitations: ResearchCapabilityLimitation[], subjectId: string): CellValue | null {
  const derived = standaloneQuarterFor(current.metric, current.period.end, values);
  if (derived) return derived;
  limitations.push({ code: "COMPARABLE_PERIOD_MISSING", subjectId, metric: current.metric, comparisonKind: "qoq", periodEnd: current.period.end.slice(0, 10), retryable: false });
  return null;
}

function standaloneQuarterFor(metric: FinancialMetricId, periodEnd: string, values: Map<string, CellValue>): CellValue | undefined {
  const current = values.get(cellKey(metric, periodEnd));
  if (!current) return undefined;
  if (current.period.basis === "quarter") return { ...current, period: quarterPeriod(periodEnd) };
  const previousEnd = previousCumulativeEnd(periodEnd);
  if (!previousEnd) return undefined;
  const previous = values.get(cellKey(metric, previousEnd));
  if (!previous) return undefined;
  const artifacts = uniqueArtifacts([...current.artifacts, ...previous.artifacts]);
  return {
    metric,
    value: deriveStandaloneQuarter({ periodEnd, currentCumulative: current.value, previousCumulative: previous.value }),
    period: quarterPeriod(periodEnd),
    artifacts,
    formula: {
      id: "financial.single_quarter.v1",
      version: "1",
      expression: "current_cumulative - previous_cumulative",
      inputArtifactIds: numericArtifactIds([current, previous]),
      parameters: { currentPeriodEnd: periodEnd, previousCumulativePeriodEnd: previousEnd },
      rounding: "exact-decimal",
    },
  };
}

function comparisonsFor(
  current: CellValue,
  candidates: Array<[FinancialMetricComparison["kind"], CellValue | undefined]>,
  limitations: ResearchCapabilityLimitation[],
  subjectId: string,
): { comparisons: FinancialMetricComparison[]; artifacts: ResearchArtifact[] } {
  const artifacts = [...current.artifacts];
  const comparisons = candidates.flatMap(([kind, comparable]) => {
    if (!comparable) {
      limitations.push({ code: "COMPARABLE_PERIOD_MISSING", subjectId, metric: current.metric, comparisonKind: kind, periodEnd: current.period.end.slice(0, 10), retryable: false });
      return [];
    }
    const decimal = financialRatioChange(current.value, comparable.value);
    if (decimal === null) {
      limitations.push({ code: "COMPARISON_NOT_MEANINGFUL", subjectId, metric: current.metric, comparisonKind: kind, periodEnd: current.period.end.slice(0, 10), retryable: false });
      return [];
    }
    artifacts.push(...comparable.artifacts);
    return [{
      kind,
      comparablePeriod: comparable.period,
      decimal,
      unit: "ratio" as const,
      formula: {
        id: `financial.${kind}.v1`,
        version: "1",
        expression: "current / prior - 1",
        inputArtifactIds: numericArtifactIds([current, comparable]),
        parameters: { currentPeriodEnd: current.period.end, comparablePeriodEnd: comparable.period.end },
        rounding: "decimal-12-nearest",
      },
    }];
  }).sort((left, right) => left.kind === "yoy" ? -1 : right.kind === "yoy" ? 1 : 0);
  return { comparisons, artifacts: uniqueArtifacts(artifacts) };
}

function financialFact(
  subjectId: string,
  current: CellValue,
  variant: "reported" | "standalone-quarter",
  compared: { comparisons: FinancialMetricComparison[]; artifacts: ResearchArtifact[] },
  limitations: ResearchCapabilityLimitation[],
): FinancialMetricFact {
  const provenancePool = compared.artifacts;
  const warnings = [...new Set(provenancePool.flatMap((artifact) => artifact.warnings))].sort();
  for (const warning of warnings) {
    if (warning === "OFFICIAL_FILING_UNCORROBORATED") limitations.push({ code: warning, subjectId, metric: current.metric, periodEnd: current.period.end.slice(0, 10), retryable: false });
  }
  return {
    id: `financial:${subjectId}:${current.metric}:${current.period.end.slice(0, 10)}:${variant}`,
    kind: "financial_metric",
    subjectId,
    metric: current.metric,
    period: current.period,
    value: { decimal: current.value, unit: "CNY" },
    ...(current.formula ? { formula: current.formula } : {}),
    ...(compared.comparisons.length ? { comparisons: compared.comparisons } : {}),
    provenance: {
      providers: [...new Set(provenancePool.map((artifact) => artifact.provider))].sort(),
      sourceArtifactIds: provenancePool.map((artifact) => artifact.artifactId).sort(),
      sourceAsOf: latest(provenancePool.map((artifact) => artifact.sourceAsOf))!,
      retrievedAt: latest(provenancePool.map((artifact) => artifact.retrievedAt))!,
    },
    quality: {
      status: warnings.length ? "degraded" : "operational",
      reliable: warnings.length === 0,
      coverage: { actual: current.formula ? 2 : 1, required: current.formula ? 2 : 1 },
      warnings,
    },
  };
}

function numericArtifactIds(values: CellValue[]): string[] {
  const artifacts = uniqueArtifacts(values.flatMap((value) => value.artifacts).filter((artifact) => artifact.kind === "financial_statement.v1"));
  return artifacts.map((artifact) => artifact.artifactId).sort();
}

function uniqueArtifacts(artifacts: ResearchArtifact[]): ResearchArtifact[] {
  return [...new Map(artifacts.map((artifact) => [artifact.artifactId, artifact] as const)).values()];
}

function cellKey(metric: FinancialMetricId, periodEnd: string): string { return `${metric}:${periodEnd}`; }
function latest(values: string[]): string | null { return [...values].sort().at(-1) ?? null; }
function yearAgo(value: string): string { const date = new Date(value); date.setUTCFullYear(date.getUTCFullYear() - 1); return date.toISOString(); }
function previousQuarterEnd(value: string): string {
  const year = Number(value.slice(0, 4));
  const suffix = value.slice(5, 10);
  if (suffix === "03-31") return `${year - 1}-12-31T00:00:00.000Z`;
  if (suffix === "06-30") return `${year}-03-31T00:00:00.000Z`;
  if (suffix === "09-30") return `${year}-06-30T00:00:00.000Z`;
  return `${year}-09-30T00:00:00.000Z`;
}
function previousCumulativeEnd(value: string): string | null {
  const year = value.slice(0, 4);
  const suffix = value.slice(5, 10);
  if (suffix === "06-30") return `${year}-03-31T00:00:00.000Z`;
  if (suffix === "09-30") return `${year}-06-30T00:00:00.000Z`;
  if (suffix === "12-31") return `${year}-09-30T00:00:00.000Z`;
  return null;
}
function quarterPeriod(end: string): FinancialReportingPeriod {
  const year = end.slice(0, 4);
  const suffix = end.slice(5, 10);
  const start = suffix === "03-31" ? `${year}-01-01T00:00:00.000Z`
    : suffix === "06-30" ? `${year}-04-01T00:00:00.000Z`
      : suffix === "09-30" ? `${year}-07-01T00:00:00.000Z`
        : `${year}-10-01T00:00:00.000Z`;
  return { start, end, basis: "quarter" };
}
function stockPeriod(end: string): FinancialReportingPeriod { return { start: end, end, basis: "point_in_time" }; }
function asStockValue(value: CellValue | undefined): CellValue | undefined { return value ? { ...value, period: stockPeriod(value.period.end) } : undefined; }
function dedupeLimitations(limitations: ResearchCapabilityLimitation[]): ResearchCapabilityLimitation[] {
  return [...new Map(limitations.map((limitation) => [JSON.stringify(limitation), limitation] as const)).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
