import type { BenchmarkMapping, VersionedBenchmarkMappingPort } from "./fact-plane.ts";

export const PERSONAL_BENCHMARK_MAPPINGS: readonly BenchmarkMapping[] = [
  {
    instrumentId: "SSE:600000",
    benchmarkInstrumentId: "SSE:000300",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    methodologyVersion: "zxlab-personal-benchmark.v1",
    source: "zxlab-explicit-personal-benchmark-registry",
  },
];

export class StaticVersionedBenchmarkMappingRegistry implements VersionedBenchmarkMappingPort {
  constructor(private readonly mappings: readonly BenchmarkMapping[] = PERSONAL_BENCHMARK_MAPPINGS) {}

  async findEffectiveBenchmark(input: { instrumentId: string; observationCutoff: string }): Promise<BenchmarkMapping | null> {
    return this.mappings.find((mapping) => mapping.instrumentId === input.instrumentId
      && Date.parse(mapping.validFrom) <= Date.parse(input.observationCutoff)
      && (mapping.validTo === null || Date.parse(mapping.validTo) > Date.parse(input.observationCutoff))) ?? null;
  }
}
