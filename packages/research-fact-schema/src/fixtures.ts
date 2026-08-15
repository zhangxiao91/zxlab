import type {
  InstrumentMappingFact,
  MarketBaselineFact,
  MarketBaselineType,
  MarketBaselineWindow,
  ResearchFactBundle,
} from "./index.ts";

const observationCutoff = "2026-08-14T07:00:00.000Z";
const knowledgeCutoff = "2026-08-14T07:00:00.500Z";
const generatedAt = "2026-08-14T07:00:01.000Z";
const instrumentId = "SSE:600000";
const benchmarkId = "SSE:000300";

export function researchFactBundleFixture(): ResearchFactBundle {
  const mapping: InstrumentMappingFact = {
    id: "mapping:SSE:600000:benchmark:SSE:000300",
    kind: "instrument_mapping",
    subjectId: instrumentId,
    mappingType: "benchmark",
    targetId: benchmarkId,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    methodologyVersion: "cn-equity-benchmark.v1",
    provenance: provenance("mapping:official:2026"),
    quality: quality(1, 1),
  };
  const windows: MarketBaselineWindow[] = [20, 60, 250];
  const types: MarketBaselineType[] = ["price_return", "volume_median", "realized_volatility", "relative_return"];
  const baselines = windows.flatMap((window) => types.map((baselineType) => baseline(baselineType, window)));
  const facts = [mapping, ...baselines];
  return {
    schemaVersion: "research-facts.v2",
    planVersion: "relative-performance.v1",
    purpose: "relative_performance",
    observationCutoff,
    knowledgeCutoff,
    generatedAt,
    instrumentIds: [instrumentId],
    facts,
    capabilities: [
      capability("instrument_mapping", [mapping.id]),
      capability("market_baselines", baselines.map((fact) => fact.id)),
      unavailableCapability("fundamentals"),
      unavailableCapability("valuation"),
      unavailableCapability("documents"),
      unavailableCapability("calendar"),
    ],
    fingerprint: `sha256:${"0".repeat(64)}`,
  };
}

function baseline(baselineType: MarketBaselineType, window: MarketBaselineWindow): MarketBaselineFact {
  const required = baselineType === "volume_median" ? window : window + 1;
  const unit = baselineType === "volume_median" ? "shares" as const : "ratio" as const;
  const inputArtifactIds = [
    `daily-bars:${instrumentId}:qfq:${observationCutoff}`,
    ...(baselineType === "relative_return" ? [`daily-bars:${benchmarkId}:qfq:${observationCutoff}`] : []),
  ];
  return {
    id: `baseline:${instrumentId}:${baselineType}:${window}`,
    kind: "market_baseline",
    subjectId: instrumentId,
    baselineType,
    window,
    ...(baselineType === "relative_return" ? { benchmarkId } : {}),
    observationPeriod: {
      start: window === 20 ? "2026-07-17T07:00:00.000Z" : window === 60 ? "2026-05-22T07:00:00.000Z" : "2025-08-12T07:00:00.000Z",
      end: observationCutoff,
      tradingSessions: window,
    },
    value: {
      decimal: baselineType === "volume_median" ? "81234567" : "0.1234",
      unit,
    },
    formula: {
      id: formulaId(baselineType),
      version: "1",
      expression: formulaExpression(baselineType),
      inputArtifactIds,
      parameters: { window: String(window), annualizationSessions: "250", adjustment: "qfq" },
      rounding: "decimal-12-nearest",
    },
    provenance: provenance(inputArtifactIds),
    quality: quality(required, required),
  };
}

function provenance(sourceArtifactId: string | string[]) {
  return {
    providers: ["official-fixture"],
    sourceArtifactIds: Array.isArray(sourceArtifactId) ? sourceArtifactId : [sourceArtifactId],
    sourceAsOf: observationCutoff,
    retrievedAt: knowledgeCutoff,
  };
}

function quality(actual: number, required: number) {
  return {
    status: "operational" as const,
    reliable: true,
    coverage: { actual, required },
    warnings: [],
  };
}

function capability(id: "instrument_mapping" | "market_baselines", factIds: string[]) {
  return {
    id,
    required: true,
    status: "operational" as const,
    factIds,
    asOf: observationCutoff,
    retrievedAt: knowledgeCutoff,
    warnings: [],
    limitations: [],
  };
}

function unavailableCapability(id: "fundamentals" | "valuation" | "documents" | "calendar") {
  return {
    id,
    required: false,
    status: "unavailable" as const,
    factIds: [],
    asOf: null,
    retrievedAt: knowledgeCutoff,
    warnings: [`${id} is not implemented in relative-performance.v1`],
    limitations: [{ code: "CAPABILITY_NOT_IMPLEMENTED", retryable: false }],
    error: { code: "CAPABILITY_NOT_IMPLEMENTED", retryable: false },
  };
}

function formulaId(type: MarketBaselineType): string {
  return `market.${type}.v1`;
}

function formulaExpression(type: MarketBaselineType): string {
  if (type === "price_return") return "close[t] / close[t-window] - 1";
  if (type === "volume_median") return "median(volume[t-window+1..t])";
  if (type === "realized_volatility") return "sample_stddev(ln(close[t]/close[t-1])) * sqrt(250)";
  return "subject_return - benchmark_return";
}
