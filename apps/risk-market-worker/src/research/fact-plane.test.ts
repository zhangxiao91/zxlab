import assert from "node:assert/strict";
import test from "node:test";
import { ResearchFactPlane, type DailyHistoryPort, type VersionedBenchmarkMappingPort } from "./fact-plane.ts";
import { validateResearchFactBundle, verifyResearchFactBundleFingerprint } from "@zxlab/research-fact-schema";
import { StaticVersionedBenchmarkMappingRegistry } from "./benchmark-mappings.ts";
import { InMemoryPointInTimeResearchArtifactStore, ResearchArtifactStoreError, UnavailablePointInTimeResearchArtifactStore, type FinancialStatementProjection, type OfficialFilingProjection, type PointInTimeResearchArtifactStore, type ResearchArtifactCandidate } from "./artifact-store.ts";
import type { FinancialStatementPort } from "./financial-statements.ts";

const AS_OF = "2026-08-14T07:00:00.000Z";
const SUNDAY = "2026-08-16T04:00:00.000Z";
const FINANCIAL_NOW = "2026-08-23T07:00:00.000Z";

function constantHistory(instrumentId: string, sessions = 251): DailyHistoryPort {
  return {
    async loadDailyHistory() {
      return {
        instrumentId,
        provider: "fixture-bars",
        providerVersion: "fixture-bars.v1",
        retrievedAt: AS_OF,
        bars: Array.from({ length: sessions }, (_, index) => ({
          sessionDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
          close: "100",
          volume: "1000",
          turnover: "5000",
        })),
      };
    },
  };
}

function historyEndingAt(instrumentId: string, endDate: string, sessions = 251): DailyHistoryPort {
  return {
    async loadDailyHistory() {
      const end = new Date(`${endDate}T00:00:00.000Z`);
      return {
        instrumentId,
        provider: "fixture-bars",
        providerVersion: "fixture-bars.v1",
        retrievedAt: SUNDAY,
        bars: Array.from({ length: sessions }, (_, index) => {
          const date = new Date(end);
          date.setUTCDate(date.getUTCDate() - (sessions - index - 1));
          return { sessionDate: date.toISOString().slice(0, 10), close: "100", volume: "1000", turnover: "5000" };
        }),
      };
    },
  };
}

const noMappings: VersionedBenchmarkMappingPort = {
  async findEffectiveBenchmark() { return null; },
};

function statementCandidate(periodEnd: string, basis: FinancialStatementProjection["reportPeriod"]["basis"], values: Record<string, string>, filingKey: string): ResearchArtifactCandidate[] {
  const start = basis === "quarter" && periodEnd.endsWith("03-31T00:00:00.000Z") ? `${periodEnd.slice(0, 4)}-01-01T00:00:00.000Z` : `${periodEnd.slice(0, 4)}-01-01T00:00:00.000Z`;
  const definitions: Array<[FinancialStatementProjection["statementType"], string[]]> = [
    ["income", ["operating_revenue", "operating_profit", "net_profit_attributable_to_parent"]],
    ["cash_flow", ["net_cash_flow_from_operating_activities"]],
    ["balance_sheet", ["total_assets"]],
  ];
  return definitions.map(([statementType, metrics]) => {
    const projection: FinancialStatementProjection = {
      statementType,
      reportPeriod: { start, end: periodEnd, basis },
      reportTypeCode: "fixture",
      dataState: "F",
      cells: metrics.map((metric) => ({ metric, value: values[metric], unit: "CNY" })),
    };
    return {
      kind: "financial_statement.v1",
      subjectId: "SSE:600000",
      logicalKey: `SSE:600000:${statementType}:${periodEnd}:${basis}`,
      provider: "fixture-financials",
      providerVersion: "fixture-financials.v1",
      sourceAsOf: `${periodEnd.slice(0, 4)}-08-20T00:00:00.000Z`,
      retrievedAt: FINANCIAL_NOW,
      payload: { ...projection, officialFilingLogicalKey: filingKey },
      rawPayload: { fixture: true, projection },
      projection,
    };
  });
}

function filingCandidate(periodEnd: string): ResearchArtifactCandidate {
  const year = periodEnd.slice(0, 4);
  const type: OfficialFilingProjection["reportType"] = periodEnd.includes("06-30") ? "semiannual" : "quarterly";
  const projection: OfficialFilingProjection = { filingId: `filing-${periodEnd}`, reportPeriodEnd: periodEnd, reportType: type, title: `${year} report`, publishedAt: `${year}-08-20T01:00:00.000Z`, url: `https://static.cninfo.com.cn/${year}.pdf` };
  return { kind: "official_filing_identity.v1", subjectId: "SSE:600000", logicalKey: `SSE:600000:official-filing:${periodEnd}:${type}`, provider: "fixture-cninfo", providerVersion: "fixture-cninfo.v1", sourceAsOf: projection.publishedAt, retrievedAt: FINANCIAL_NOW, payload: projection, rawPayload: { fixture: true }, projection };
}

function companyUpdatePort(): FinancialStatementPort {
  const periods = [
    { end: "2025-03-31T00:00:00.000Z", basis: "quarter" as const, values: { operating_revenue: "40", operating_profit: "8", net_profit_attributable_to_parent: "6", net_cash_flow_from_operating_activities: "5", total_assets: "760" } },
    { end: "2025-06-30T00:00:00.000Z", basis: "year_to_date" as const, values: { operating_revenue: "100", operating_profit: "20", net_profit_attributable_to_parent: "16", net_cash_flow_from_operating_activities: "15", total_assets: "800" } },
    { end: "2026-03-31T00:00:00.000Z", basis: "quarter" as const, values: { operating_revenue: "50", operating_profit: "10", net_profit_attributable_to_parent: "8", net_cash_flow_from_operating_activities: "7", total_assets: "850" } },
    { end: "2026-06-30T00:00:00.000Z", basis: "year_to_date" as const, values: { operating_revenue: "120", operating_profit: "25", net_profit_attributable_to_parent: "20", net_cash_flow_from_operating_activities: "18", total_assets: "900" } },
  ];
  return {
    async loadArtifacts() {
      const filings = periods.map((period) => filingCandidate(period.end));
      const statements = periods.flatMap((period, index) => statementCandidate(period.end, period.basis, period.values, filings[index].logicalKey));
      return {
        candidates: [...statements, ...filings],
        relations: statements.map((statement, index) => ({
          fromLogicalKey: statement.logicalKey,
          toLogicalKey: filings[Math.floor(index / 3)].logicalKey,
          relation: "corroborated_by" as const,
        })),
      };
    },
  };
}

test("price_context materializes deterministic 20/60/250 session baselines", async () => {
  const plane = new ResearchFactPlane({
    history: constantHistory("SSE:600000"),
    benchmarkMappings: noMappings,
    now: () => AS_OF,
  });

  const bundle = await plane.materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });

  const baselines = bundle.facts.filter((fact) => fact.kind === "market_baseline");
  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.equal(bundle.observationCutoff, AS_OF);
  assert.equal(bundle.knowledgeCutoff, bundle.generatedAt);
  assert.equal(await verifyResearchFactBundleFingerprint(bundle), true);
  assert.deepEqual(baselines.filter((fact) => fact.baselineType === "price_return").map((fact) => fact.window), [20, 60, 250]);
  assert.deepEqual(baselines.filter((fact) => fact.baselineType === "price_return").map((fact) => fact.value.decimal), ["0", "0", "0"]);
  assert.deepEqual(baselines.filter((fact) => fact.baselineType === "volume_median").map((fact) => fact.value.decimal), ["1000", "1000", "1000"]);
  assert.deepEqual(baselines.filter((fact) => fact.baselineType === "realized_volatility").map((fact) => fact.value.decimal), ["0", "0", "0"]);
  assert.ok(baselines.every((fact) => fact.formula.version === "1"));
  assert.equal(bundle.capabilities[0].status, "operational");
  assert.match(bundle.fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("expected latest session caps future daily bars and is sealed into an operational bundle", async () => {
  const bundle = await new ResearchFactPlane({
    history: historyEndingAt("SSE:600000", "2026-08-15", 252),
    benchmarkMappings: noMappings,
    now: () => SUNDAY,
  }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: SUNDAY,
    expectedLatestSessionDate: "2026-08-14",
  });

  assert.equal(bundle.expectedLatestSessionDate, "2026-08-14");
  assert.equal(bundle.capabilities[0].status, "operational");
  assert.ok(bundle.facts.filter((fact) => fact.kind === "market_baseline").every((fact) => fact.observationPeriod.end === "2026-08-14T07:00:00.000Z"));
  assert.equal(await verifyResearchFactBundleFingerprint(bundle), true);
});

test("a lagging latest session degrades only market baselines while retaining deterministic facts", async () => {
  const bundle = await new ResearchFactPlane({
    history: historyEndingAt("SSE:600000", "2026-08-13"),
    benchmarkMappings: noMappings,
    now: () => SUNDAY,
  }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: SUNDAY,
    expectedLatestSessionDate: "2026-08-14",
  });

  const capability = bundle.capabilities.find((item) => item.id === "market_baselines")!;
  assert.equal(capability.status, "degraded");
  assert.equal(capability.asOf, "2026-08-13T07:00:00.000Z");
  assert.deepEqual(capability.warnings, ["LATEST_SESSION_MISSING"]);
  assert.deepEqual(capability.limitations, [{
    code: "LATEST_SESSION_MISSING",
    subjectId: "SSE:600000",
    expectedSessionDate: "2026-08-14",
    actualSessionDate: "2026-08-13",
    retryable: false,
  }]);
  const facts = bundle.facts.filter((fact) => fact.kind === "market_baseline");
  assert.ok(facts.length > 0);
  assert.ok(facts.every((fact) => fact.quality.status === "degraded" && !fact.quality.reliable && fact.quality.warnings.includes("LATEST_SESSION_MISSING")));
  assert.equal(validateResearchFactBundle(bundle).ok, true);
});

test("relative_performance uses an explicit versioned benchmark mapping and aligned histories", async () => {
  const history: DailyHistoryPort = {
    async loadDailyHistory(input) {
      return constantHistory(input.instrumentId).loadDailyHistory(input);
    },
  };
  const mappings: VersionedBenchmarkMappingPort = {
    async findEffectiveBenchmark({ instrumentId }) {
      return {
        instrumentId,
        benchmarkInstrumentId: "SSE:000300",
        validFrom: "2025-01-01T00:00:00.000Z",
        validTo: null,
        methodologyVersion: "personal-benchmark-map.v1",
        source: "explicit-profile-mapping",
      };
    },
  };
  const bundle = await new ResearchFactPlane({ history, benchmarkMappings: mappings, now: () => AS_OF }).materialize({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    selectedInstrumentId: "SSE:600000",
    observationCutoff: AS_OF,
  });

  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.equal(bundle.facts.filter((fact) => fact.kind === "instrument_mapping").length, 1);
  const relative = bundle.facts.filter((fact) => fact.kind === "market_baseline" && fact.baselineType === "relative_return");
  assert.deepEqual(relative.map((fact) => fact.window), [20, 60, 250]);
  assert.ok(relative.every((fact) => fact.benchmarkId === "SSE:000300" && fact.value.decimal === "0"));
  assert.deepEqual(bundle.capabilities.map((item) => [item.id, item.status]), [
    ["instrument_mapping", "operational"],
    ["market_baselines", "operational"],
  ]);
});

test("benchmark-only latest-session lag degrades relative returns but preserves direct subject baselines", async () => {
  const history: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const source = input.instrumentId === "SSE:000300"
        ? historyEndingAt(input.instrumentId, "2026-08-13", 251)
        : historyEndingAt(input.instrumentId, "2026-08-14", 252);
      return source.loadDailyHistory(input);
    },
  };
  const mappings: VersionedBenchmarkMappingPort = {
    async findEffectiveBenchmark({ instrumentId }) {
      return { instrumentId, benchmarkInstrumentId: "SSE:000300", validFrom: "2026-01-01T00:00:00.000Z", validTo: null, methodologyVersion: "personal-benchmark-map.v1", source: "explicit-profile-mapping" };
    },
  };
  const bundle = await new ResearchFactPlane({ history, benchmarkMappings: mappings, now: () => SUNDAY }).materialize({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    expectedLatestSessionDate: "2026-08-14",
    observationCutoff: SUNDAY,
  });

  assert.deepEqual(bundle.capabilities.map((item) => [item.id, item.status]), [
    ["instrument_mapping", "operational"],
    ["market_baselines", "degraded"],
  ]);
  const limitation = bundle.capabilities.find((item) => item.id === "market_baselines")!.limitations;
  assert.deepEqual(limitation, [{ code: "LATEST_SESSION_MISSING", subjectId: "SSE:600000", baselineType: "relative_return", expectedSessionDate: "2026-08-14", actualSessionDate: "2026-08-13", retryable: false }]);
  const direct = bundle.facts.filter((fact) => fact.kind === "market_baseline" && fact.baselineType !== "relative_return");
  const relative = bundle.facts.filter((fact) => fact.kind === "market_baseline" && fact.baselineType === "relative_return");
  assert.ok(direct.every((fact) => fact.quality.status === "operational" && fact.quality.reliable));
  assert.ok(relative.every((fact) => fact.quality.status === "degraded" && !fact.quality.reliable && fact.quality.warnings.includes("LATEST_SESSION_MISSING")));
});

test("a lagging subject that is also a benchmark limits itself and every relative-return consumer", async () => {
  const history: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const endDate = input.instrumentId === "SSE:000300" ? "2026-08-13" : "2026-08-14";
      return historyEndingAt(input.instrumentId, endDate, endDate === "2026-08-13" ? 251 : 252).loadDailyHistory(input);
    },
  };
  const mappings: VersionedBenchmarkMappingPort = {
    async findEffectiveBenchmark({ instrumentId }) {
      const benchmarkInstrumentId = instrumentId === "SSE:600000" ? "SSE:000300" : "SSE:000905";
      return { instrumentId, benchmarkInstrumentId, validFrom: "2026-01-01T00:00:00.000Z", validTo: null, methodologyVersion: "personal-benchmark-map.v1", source: "explicit-profile-mapping" };
    },
  };
  const bundle = await new ResearchFactPlane({ history, benchmarkMappings: mappings, now: () => SUNDAY }).materialize({
    purpose: "relative_performance",
    instrumentIds: ["SSE:000300", "SSE:600000"],
    expectedLatestSessionDate: "2026-08-14",
    observationCutoff: SUNDAY,
  });

  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.deepEqual(bundle.capabilities.find((item) => item.id === "market_baselines")!.limitations, [
    { code: "LATEST_SESSION_MISSING", subjectId: "SSE:000300", expectedSessionDate: "2026-08-14", actualSessionDate: "2026-08-13", retryable: false },
    { code: "LATEST_SESSION_MISSING", subjectId: "SSE:600000", baselineType: "relative_return", expectedSessionDate: "2026-08-14", actualSessionDate: "2026-08-13", retryable: false },
  ]);
});

test("relative_performance reports partial deterministic coverage instead of guessing a benchmark", async () => {
  const bundle = await new ResearchFactPlane({
    history: constantHistory("SSE:600000"),
    benchmarkMappings: noMappings,
    now: () => AS_OF,
  }).materialize({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });

  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.equal(bundle.facts.some((fact) => fact.kind === "instrument_mapping"), false);
  assert.equal(bundle.facts.some((fact) => fact.kind === "market_baseline" && fact.baselineType === "relative_return"), false);
  assert.deepEqual(bundle.capabilities.map((item) => [item.id, item.status, item.warnings]), [
    ["instrument_mapping", "unavailable", ["BENCHMARK_MAPPING_MISSING"]],
    ["market_baselines", "degraded", ["BENCHMARK_MAPPING_MISSING"]],
  ]);
});

test("observation cutoff before the market close excludes that same-day daily bar", async () => {
  const history: DailyHistoryPort = {
    async loadDailyHistory({ instrumentId }) {
      return {
        instrumentId,
        provider: "fixture-bars",
        providerVersion: "fixture-bars.v1",
        retrievedAt: AS_OF,
        bars: Array.from({ length: 21 }, (_, index) => ({
          sessionDate: new Date(Date.UTC(2026, 6, 25 + index)).toISOString().slice(0, 10),
          close: "100",
          volume: "1000",
          turnover: "5000",
        })),
      };
    },
  };
  const bundle = await new ResearchFactPlane({ history, benchmarkMappings: noMappings, now: () => AS_OF }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: "2026-08-14T06:59:59.000Z",
  });

  assert.equal(bundle.facts.some((fact) => fact.kind === "market_baseline" && fact.baselineType === "price_return" && fact.window === 20), false);
  assert.equal(bundle.capabilities[0].status, "degraded");
  assert.deepEqual(bundle.capabilities[0].warnings, ["INSUFFICIENT_SAMPLE"]);
  assert.deepEqual(bundle.capabilities[0].limitations.find((item) => item.baselineType === "price_return" && item.window === 20), {
    code: "INSUFFICIENT_SAMPLE",
    subjectId: "SSE:600000",
    baselineType: "price_return",
    window: 20,
    actual: 20,
    required: 21,
    retryable: false,
  });
});

test("production mapping registry exposes only explicit versioned mappings effective at the cutoff", async () => {
  const registry = new StaticVersionedBenchmarkMappingRegistry();
  const active = await registry.findEffectiveBenchmark({ instrumentId: "SSE:600000", observationCutoff: AS_OF });
  const beforeEffective = await registry.findEffectiveBenchmark({ instrumentId: "SSE:600000", observationCutoff: "2025-12-31T23:59:59.000Z" });
  const unknown = await registry.findEffectiveBenchmark({ instrumentId: "SSE:601398", observationCutoff: AS_OF });
  assert.deepEqual(active, {
    instrumentId: "SSE:600000",
    benchmarkInstrumentId: "SSE:000300",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    methodologyVersion: "zxlab-personal-benchmark.v1",
    source: "zxlab-explicit-personal-benchmark-registry",
  });
  assert.equal(beforeEffective, null);
  assert.equal(unknown, null);
});

test("relative_performance preserves the mapping fact when history providers are exhausted", async () => {
  const history: DailyHistoryPort = { async loadDailyHistory() { throw Object.assign(new Error("provider unavailable"), { code: "ALL_PROVIDERS_FAILED" }); } };
  const mappings: VersionedBenchmarkMappingPort = {
    async findEffectiveBenchmark({ instrumentId }) {
      return { instrumentId, benchmarkInstrumentId: "SSE:000300", validFrom: "2026-01-01T00:00:00.000Z", validTo: null, methodologyVersion: "personal-benchmark-map.v1", source: "explicit-profile-mapping" };
    },
  };
  const bundle = await new ResearchFactPlane({ history, benchmarkMappings: mappings, now: () => AS_OF }).materialize({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });
  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.deepEqual(bundle.capabilities.map((item) => [item.id, item.status]), [
    ["instrument_mapping", "operational"],
    ["market_baselines", "unavailable"],
  ]);
});

test("provider fallback warnings degrade fact and capability quality without dropping deterministic values", async () => {
  const fallbackHistory: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await constantHistory(input.instrumentId).loadDailyHistory(input);
      return { ...loaded, warnings: ["PROVIDER_FALLBACK_USED"] };
    },
  };
  const bundle = await new ResearchFactPlane({ history: fallbackHistory, benchmarkMappings: noMappings, now: () => AS_OF }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });
  assert.ok(bundle.facts.every((fact) => fact.quality.status === "degraded" && fact.quality.reliable === false));
  assert.equal(bundle.capabilities[0].status, "degraded");
  assert.deepEqual(bundle.capabilities[0].warnings, ["PROVIDER_FALLBACK_USED"]);
});

test("materialization rejects observation cutoffs outside the trailing fifteen-minute window before provider I/O", async () => {
  let historyCalls = 0;
  const history: DailyHistoryPort = {
    async loadDailyHistory(input) {
      historyCalls += 1;
      return constantHistory(input.instrumentId).loadDailyHistory(input);
    },
  };
  const plane = new ResearchFactPlane({ history, benchmarkMappings: noMappings, now: () => AS_OF });
  await assert.rejects(plane.materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: "2026-08-14T06:44:59.999Z",
  }), /OBSERVATION_CUTOFF_OUT_OF_RANGE/);
  await assert.rejects(plane.materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: "2026-08-14T07:00:00.001Z",
  }), /OBSERVATION_CUTOFF_OUT_OF_RANGE/);
  assert.equal(historyCalls, 0);
});

test("daily input artifacts are content-addressed and formulas pin qfq adjustment", async () => {
  const artifactStore = new InMemoryPointInTimeResearchArtifactStore({ now: () => AS_OF });
  const first = await new ResearchFactPlane({ history: constantHistory("SSE:600000"), benchmarkMappings: noMappings, artifactStore, artifactMode: "required", now: () => AS_OF }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });
  const changedHistory: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await constantHistory(input.instrumentId).loadDailyHistory(input);
      return { ...loaded, bars: loaded.bars.map((bar, index) => index === 0 ? { ...bar, close: "101" } : bar) };
    },
  };
  const second = await new ResearchFactPlane({ history: changedHistory, benchmarkMappings: noMappings, now: () => AS_OF }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });
  const firstArtifacts = first.facts.filter((fact) => fact.kind === "market_baseline").flatMap((fact) => fact.formula.inputArtifactIds);
  const secondArtifacts = second.facts.filter((fact) => fact.kind === "market_baseline").flatMap((fact) => fact.formula.inputArtifactIds);
  assert.ok(firstArtifacts.every((artifactId) => /^daily-bars:SSE:600000:sha256:[a-f0-9]{64}$/.test(artifactId)));
  assert.notDeepEqual([...new Set(firstArtifacts)], [...new Set(secondArtifacts)]);
  assert.ok(first.facts.filter((fact) => fact.kind === "market_baseline").every((fact) => fact.formula.parameters.adjustment === "qfq"));
  const stored = await artifactStore.selectAsOf({ subjectIds: ["SSE:600000"], kinds: ["normalized_daily_history.v1"], observationCutoff: AS_OF, knowledgeCutoff: AS_OF });
  assert.equal(stored.artifacts.length, 1);
  assert.equal(stored.artifacts[0].artifactId, firstArtifacts[0]);
});

test("shadow capture persists daily artifacts without changing the legacy price-context output", async () => {
  const history = constantHistory("SSE:600000");
  const request = { purpose: "price_context" as const, instrumentIds: ["SSE:600000"], observationCutoff: AS_OF };
  const disabled = await new ResearchFactPlane({ history, benchmarkMappings: noMappings, now: () => AS_OF }).materialize(request);
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => AS_OF });
  const shadow = await new ResearchFactPlane({ history, benchmarkMappings: noMappings, artifactStore: store, artifactMode: "shadow", now: () => AS_OF }).materialize(request);

  assert.deepEqual(shadow, disabled);
  assert.equal((await store.selectAsOf({
    subjectIds: ["SSE:600000"],
    kinds: ["normalized_daily_history.v1"],
    observationCutoff: AS_OF,
    knowledgeCutoff: AS_OF,
  })).artifacts.length, 1);
});

test("history subject and normalized bar integrity failures abort the whole materialization", async () => {
  const mismatched: DailyHistoryPort = {
    async loadDailyHistory(input) {
      return constantHistory(input.instrumentId === "SSE:600000" ? "SSE:600001" : input.instrumentId).loadDailyHistory(input);
    },
  };
  const invalidBar: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await constantHistory(input.instrumentId).loadDailyHistory(input);
      return { ...loaded, bars: loaded.bars.map((bar, index) => index === 0 ? { ...bar, close: "not-a-number" } : bar) };
    },
  };
  for (const history of [mismatched, invalidBar]) {
    const plane = new ResearchFactPlane({ history, benchmarkMappings: noMappings, now: () => AS_OF });
    await assert.rejects(plane.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: AS_OF }), /RESEARCH_HISTORY_INTEGRITY_FAILURE/);
  }
});

test("server knowledge cutoff is assigned after collection and bounds retrieval provenance", async () => {
  const retrievedAt = "2026-08-14T07:00:03.000Z";
  const generatedAt = "2026-08-14T07:00:05.000Z";
  const collectedHistory: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await constantHistory(input.instrumentId).loadDailyHistory(input);
      return { ...loaded, retrievedAt };
    },
  };
  let clockReads = 0;
  const plane = new ResearchFactPlane({ history: collectedHistory, benchmarkMappings: noMappings, now: () => clockReads++ === 0 ? AS_OF : generatedAt });
  const bundle = await plane.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: AS_OF });
  assert.equal(bundle.observationCutoff, AS_OF);
  assert.equal(bundle.knowledgeCutoff, retrievedAt);
  assert.equal(bundle.generatedAt, generatedAt);
  assert.ok(bundle.facts.every((fact) => fact.provenance.retrievedAt === retrievedAt && fact.provenance.retrievedAt <= bundle.knowledgeCutoff));
});

test("knowledge cutoff uses the latest included artifact observation while generatedAt remains report time", async () => {
  const retrievedAt = "2026-08-14T07:00:02.000Z";
  const firstObservedAt = "2026-08-14T07:00:04.000Z";
  const generatedAt = "2026-08-14T07:00:05.000Z";
  const artifactStore = new InMemoryPointInTimeResearchArtifactStore({ now: () => firstObservedAt });
  const history: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await constantHistory(input.instrumentId).loadDailyHistory(input);
      return { ...loaded, retrievedAt };
    },
  };
  let clockReads = 0;
  const bundle = await new ResearchFactPlane({ history, benchmarkMappings: noMappings, artifactStore, artifactMode: "required", now: () => clockReads++ === 0 ? AS_OF : generatedAt }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: AS_OF,
  });

  assert.equal(bundle.knowledgeCutoff, firstObservedAt);
  assert.equal(bundle.generatedAt, generatedAt);
  assert.ok(bundle.facts.every((fact) => fact.provenance.retrievedAt === retrievedAt));
  assert.equal(validateResearchFactBundle(bundle).ok, true);
});

test("provider failure falls back to the latest legal daily artifact without treating Sunday as stale", async () => {
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => AS_OF });
  const initial = await new ResearchFactPlane({ history: historyEndingAt("SSE:600000", "2026-08-14", 251), benchmarkMappings: noMappings, artifactStore: store, artifactMode: "required", now: () => SUNDAY }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: SUNDAY,
    expectedLatestSessionDate: "2026-08-14",
  });
  const initialArtifactId = initial.facts.find((fact) => fact.kind === "market_baseline")!.formula.inputArtifactIds[0];
  const unavailable: DailyHistoryPort = { async loadDailyHistory() { throw Object.assign(new Error("provider unavailable"), { code: "ALL_PROVIDERS_FAILED" }); } };
  const bundle = await new ResearchFactPlane({ history: unavailable, benchmarkMappings: noMappings, artifactStore: store, artifactMode: "required", now: () => SUNDAY }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: SUNDAY,
    expectedLatestSessionDate: "2026-08-14",
  });

  const baselines = bundle.facts.filter((fact) => fact.kind === "market_baseline");
  assert.ok(baselines.length > 0);
  assert.ok(baselines.every((fact) => fact.formula.inputArtifactIds.includes(initialArtifactId) && fact.quality.status === "degraded"));
  assert.equal(bundle.capabilities[0].status, "degraded");
  assert.ok(bundle.capabilities[0].limitations.some((limitation) => limitation.code === "HISTORY_PROVIDER_EXHAUSTED" && limitation.retryable));
  assert.equal(bundle.capabilities[0].limitations.some((limitation) => limitation.code === "LATEST_SESSION_MISSING"), false);
  assert.equal(bundle.capabilities[0].asOf, "2026-08-14T07:00:00.000Z");
});

test("persistence failure uses the prior stored revision instead of unpersisted provider data", async () => {
  const seeded = new InMemoryPointInTimeResearchArtifactStore({ now: () => AS_OF });
  const initial = await new ResearchFactPlane({ history: historyEndingAt("SSE:600000", "2026-08-14", 251), benchmarkMappings: noMappings, artifactStore: seeded, artifactMode: "required", now: () => SUNDAY }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: SUNDAY,
    expectedLatestSessionDate: "2026-08-14",
  });
  const initialArtifactId = initial.facts.find((fact) => fact.kind === "market_baseline")!.formula.inputArtifactIds[0];
  const store: PointInTimeResearchArtifactStore = {
    async capture() { throw new ResearchArtifactStoreError("ARTIFACT_PERSISTENCE_FAILED"); },
    selectAsOf(query) { return seeded.selectAsOf(query); },
  };
  const changedHistory: DailyHistoryPort = {
    async loadDailyHistory(input) {
      const loaded = await historyEndingAt(input.instrumentId, "2026-08-14", 251).loadDailyHistory(input);
      return { ...loaded, bars: loaded.bars.map((bar, index) => index === 0 ? { ...bar, close: "200" } : bar) };
    },
  };
  const bundle = await new ResearchFactPlane({ history: changedHistory, benchmarkMappings: noMappings, artifactStore: store, artifactMode: "required", now: () => SUNDAY }).materialize({
    purpose: "price_context",
    instrumentIds: ["SSE:600000"],
    observationCutoff: SUNDAY,
    expectedLatestSessionDate: "2026-08-14",
  });

  const baselines = bundle.facts.filter((fact) => fact.kind === "market_baseline");
  assert.ok(baselines.length > 0);
  assert.ok(baselines.every((fact) => fact.formula.inputArtifactIds.includes(initialArtifactId) && fact.quality.status === "degraded"));
  assert.ok(bundle.capabilities[0].limitations.some((limitation) => limitation.code === "ARTIFACT_PERSISTENCE_FAILED" && limitation.retryable));
  assert.equal(bundle.capabilities[0].limitations.some((limitation) => limitation.code === "LATEST_SESSION_MISSING"), false);
});

test("company update knowledge cutoff is derived from selected artifact observations", async () => {
  const firstObservedAt = "2026-08-23T07:00:03.000Z";
  const generatedAt = "2026-08-23T07:00:05.000Z";
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => firstObservedAt });
  let clockReads = 0;
  const plane = new ResearchFactPlane({
    history: constantHistory("SSE:600000"),
    benchmarkMappings: noMappings,
    artifactStore: store,
    financialStatements: companyUpdatePort(),
    artifactMode: "required",
    now: () => clockReads++ === 0 ? FINANCIAL_NOW : generatedAt,
  });
  const bundle = await plane.materialize({ purpose: "company_update", instrumentIds: ["SSE:600000"], observationCutoff: FINANCIAL_NOW });

  assert.equal(bundle.knowledgeCutoff, firstObservedAt);
  assert.equal(bundle.generatedAt, generatedAt);
  assert.equal(validateResearchFactBundle(bundle).ok, true);
});

test("company_update materializes reported and standalone-quarter financial facts with deterministic comparisons", async () => {
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => FINANCIAL_NOW });
  const plane = new ResearchFactPlane({
    history: constantHistory("SSE:600000"),
    benchmarkMappings: noMappings,
    artifactStore: store,
    financialStatements: companyUpdatePort(),
    artifactMode: "required",
    now: () => FINANCIAL_NOW,
  });
  const bundle = await plane.materialize({ purpose: "company_update", instrumentIds: ["SSE:600000"], observationCutoff: FINANCIAL_NOW });

  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.equal(bundle.planVersion, "company-update.v1");
  assert.deepEqual(bundle.capabilities.map((capability) => capability.id), ["fundamentals"]);
  const revenue = bundle.facts.filter((fact) => fact.kind === "financial_metric" && fact.metric === "operating_revenue");
  const reported = revenue.find((fact) => fact.period.basis === "year_to_date")!;
  const quarter = revenue.find((fact) => fact.period.basis === "quarter")!;
  assert.equal(reported.value.decimal, "120");
  assert.equal(reported.comparisons?.find((comparison) => comparison.kind === "yoy")?.decimal, "0.2");
  assert.equal(quarter.value.decimal, "70");
  assert.equal(quarter.formula?.id, "financial.single_quarter.v1");
  assert.equal(quarter.comparisons?.find((comparison) => comparison.kind === "yoy")?.decimal, "0.166666666667");
  assert.equal(quarter.comparisons?.find((comparison) => comparison.kind === "qoq")?.decimal, "0.4");
  const assets = bundle.facts.find((fact) => fact.kind === "financial_metric" && fact.metric === "total_assets")!;
  assert.equal(assets.value.decimal, "900");
  assert.equal(assets.comparisons?.find((comparison) => comparison.kind === "yoy")?.decimal, "0.125");
  assert.equal(assets.comparisons?.find((comparison) => comparison.kind === "qoq")?.decimal, "0.058823529412");
  assert.equal(bundle.capabilities[0].status, "operational");
  assert.equal(await verifyResearchFactBundleFingerprint(bundle), true);
});

test("company_update keeps store outage inside the fundamentals capability", async () => {
  const plane = new ResearchFactPlane({
    history: constantHistory("SSE:600000"),
    benchmarkMappings: noMappings,
    artifactStore: new UnavailablePointInTimeResearchArtifactStore(),
    financialStatements: companyUpdatePort(),
    artifactMode: "required",
    now: () => FINANCIAL_NOW,
  });
  const bundle = await plane.materialize({ purpose: "company_update", instrumentIds: ["SSE:600000"], observationCutoff: FINANCIAL_NOW });
  assert.equal(validateResearchFactBundle(bundle).ok, true);
  assert.equal(bundle.facts.length, 0);
  assert.equal(bundle.capabilities[0].status, "unavailable");
  assert.ok(bundle.capabilities[0].limitations.some((limitation) => limitation.code === "ARTIFACT_STORE_UNAVAILABLE" && limitation.retryable));
});

test("company_update keeps a current value but omits misleading ratios when the comparison base is non-positive", async () => {
  const base = companyUpdatePort();
  const financialStatements: FinancialStatementPort = {
    async loadArtifacts(input) {
      const batch = await base.loadArtifacts(input);
      for (const candidate of batch.candidates) {
        if (candidate.kind !== "financial_statement.v1" || !candidate.logicalKey.includes("2025-06-30") || !candidate.projection || !("statementType" in candidate.projection)) continue;
        const revenue = candidate.projection.cells.find((cell) => cell.metric === "operating_revenue");
        if (revenue) revenue.value = "0";
      }
      return batch;
    },
  };
  const plane = new ResearchFactPlane({
    history: constantHistory("SSE:600000"),
    benchmarkMappings: noMappings,
    artifactStore: new InMemoryPointInTimeResearchArtifactStore({ now: () => FINANCIAL_NOW }),
    financialStatements,
    artifactMode: "required",
    now: () => FINANCIAL_NOW,
  });
  const bundle = await plane.materialize({ purpose: "company_update", instrumentIds: ["SSE:600000"], observationCutoff: FINANCIAL_NOW });
  const revenue = bundle.facts.find((fact) => fact.kind === "financial_metric" && fact.metric === "operating_revenue" && fact.period.basis === "year_to_date")!;
  assert.equal(revenue.value.decimal, "120");
  assert.equal(revenue.comparisons?.some((comparison) => comparison.kind === "yoy") ?? false, false);
  assert.ok(bundle.capabilities[0].limitations.some((limitation) => limitation.code === "COMPARISON_NOT_MEANINGFUL" && limitation.metric === "operating_revenue" && limitation.comparisonKind === "yoy"));
  assert.equal(revenue.quality.reliable, true);
});
