import assert from "node:assert/strict";
import test from "node:test";
import { ResearchFactPlane, type DailyHistoryPort, type VersionedBenchmarkMappingPort } from "./fact-plane.ts";
import { validateResearchFactBundle, verifyResearchFactBundleFingerprint } from "@zxlab/research-fact-schema";
import { StaticVersionedBenchmarkMappingRegistry } from "./benchmark-mappings.ts";

const AS_OF = "2026-08-14T07:00:00.000Z";

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

const noMappings: VersionedBenchmarkMappingPort = {
  async findEffectiveBenchmark() { return null; },
};

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
  const first = await new ResearchFactPlane({ history: constantHistory("SSE:600000"), benchmarkMappings: noMappings, now: () => AS_OF }).materialize({
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
  assert.equal(bundle.knowledgeCutoff, generatedAt);
  assert.equal(bundle.generatedAt, generatedAt);
  assert.ok(bundle.facts.every((fact) => fact.provenance.retrievedAt === retrievedAt && fact.provenance.retrievedAt <= bundle.knowledgeCutoff));
});
