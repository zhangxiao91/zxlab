import {
  calculateResearchFactBundleFingerprint,
  parseResearchFactBundle,
  parseResearchFactRequest,
  type FactProvenance,
  type InstrumentMappingFact,
  type MarketBaselineFact,
  type MarketBaselineType,
  type MarketBaselineWindow,
  type ResearchCapabilityOutcome,
  type ResearchCapabilityLimitation,
  type ResearchFact,
  type ResearchFactBundle,
  type ResearchFactPlane as ResearchFactPlaneInterface,
  type ResearchFactRequest,
} from "@zxlab/research-fact-schema";
import {
  ResearchArtifactStoreError,
  type PointInTimeResearchArtifactStore,
  type ResearchArtifact,
  type ResearchArtifactCandidate,
} from "./artifact-store.ts";
import { buildCompanyUpdateFacts } from "./financial-facts.ts";
import { FinancialStatementProviderError, type FinancialStatementPort } from "./financial-statements.ts";

const WINDOWS: readonly MarketBaselineWindow[] = [20, 60, 250];
const BASELINE_ORDER: readonly MarketBaselineType[] = ["price_return", "volume_median", "realized_volatility", "relative_return"];

export interface NormalizedDailyBar {
  sessionDate: string;
  close: string;
  volume: string;
  turnover: string | null;
}

export interface DailyHistoryResult {
  instrumentId: string;
  provider: string;
  providerVersion: string;
  retrievedAt: string;
  bars: NormalizedDailyBar[];
  warnings?: string[];
}

export interface DailyHistoryPort {
  loadDailyHistory(input: { instrumentId: string; observationCutoff: string; minimumSessions: number }): Promise<DailyHistoryResult>;
}

export interface BenchmarkMapping {
  instrumentId: string;
  benchmarkInstrumentId: string;
  validFrom: string;
  validTo: string | null;
  methodologyVersion: string;
  source: string;
}

export interface VersionedBenchmarkMappingPort {
  findEffectiveBenchmark(input: { instrumentId: string; observationCutoff: string }): Promise<BenchmarkMapping | null>;
}

interface PreparedResearchFactPlan {
  planVersion: "price-context.v1" | "relative-performance.v1";
  request: ResearchFactRequest & { purpose: "price_context" | "relative_performance" };
  historySubjects: string[];
  mappings: BenchmarkMapping[];
  limitations: InternalLimitation[];
}

interface InternalLimitation extends ResearchCapabilityLimitation {
  capability: "instrument_mapping" | "market_baselines";
  message: string;
}

interface LoadedHistory {
  result: DailyHistoryResult;
  bars: NormalizedDailyBar[];
  artifactId: string;
  firstObservedAt?: string;
}

export class ResearchFactPlane implements ResearchFactPlaneInterface {
  private readonly history: DailyHistoryPort;
  private readonly benchmarkMappings: VersionedBenchmarkMappingPort;
  private readonly artifactStore?: PointInTimeResearchArtifactStore;
  private readonly financialStatements?: FinancialStatementPort;
  private readonly artifactMode: "disabled" | "shadow" | "required";
  private readonly now: () => string;

  constructor(dependencies: {
    history: DailyHistoryPort;
    benchmarkMappings: VersionedBenchmarkMappingPort;
    artifactStore?: PointInTimeResearchArtifactStore;
    financialStatements?: FinancialStatementPort;
    artifactMode?: "disabled" | "shadow" | "required";
    now?: () => string;
  }) {
    this.history = dependencies.history;
    this.benchmarkMappings = dependencies.benchmarkMappings;
    this.artifactStore = dependencies.artifactStore;
    this.financialStatements = dependencies.financialStatements;
    this.artifactMode = dependencies.artifactMode ?? "disabled";
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private async preparePlan(input: ResearchFactRequest): Promise<PreparedResearchFactPlan> {
    const request = parseResearchFactRequest(input);
    if (request.purpose !== "price_context" && request.purpose !== "relative_performance") throw new Error("UNSUPPORTED_RESEARCH_PURPOSE");
    const supported = request as PreparedResearchFactPlan["request"];
    const mappings: BenchmarkMapping[] = [];
    const limitations: PreparedResearchFactPlan["limitations"] = [];
    const historySubjects = [...request.instrumentIds];

    if (request.purpose === "relative_performance") {
      for (const instrumentId of request.instrumentIds) {
        const mapping = await this.benchmarkMappings.findEffectiveBenchmark({ instrumentId, observationCutoff: request.observationCutoff });
        if (!mapping || !mappingIsEffective(mapping, request.observationCutoff)) {
          limitations.push({ capability: "instrument_mapping", code: "BENCHMARK_MAPPING_MISSING", subjectId: instrumentId, retryable: false, message: `No explicit benchmark mapping is effective for ${instrumentId}` });
          limitations.push({ capability: "market_baselines", code: "BENCHMARK_MAPPING_MISSING", subjectId: instrumentId, baselineType: "relative_return", retryable: false, message: `Relative-return baselines require an explicit benchmark mapping for ${instrumentId}` });
          continue;
        }
        mappings.push(mapping);
        if (!historySubjects.includes(mapping.benchmarkInstrumentId)) historySubjects.push(mapping.benchmarkInstrumentId);
      }
    }

    return {
      planVersion: request.purpose === "relative_performance" ? "relative-performance.v1" : "price-context.v1",
      request: supported,
      historySubjects: historySubjects.sort(),
      mappings: mappings.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)),
      limitations,
    };
  }

  async materialize(input: ResearchFactRequest): Promise<ResearchFactBundle> {
    const request = parseResearchFactRequest(input);
    const startedAt = this.now();
    const cutoffAgeMs = Date.parse(startedAt) - Date.parse(request.observationCutoff);
    if (!Number.isFinite(cutoffAgeMs) || cutoffAgeMs < 0 || cutoffAgeMs > 15 * 60_000) throw new Error("OBSERVATION_CUTOFF_OUT_OF_RANGE");
    if (request.purpose === "company_update") return this.materializeCompanyUpdate(request as ResearchFactRequest & { purpose: "company_update" });
    const plan = await this.preparePlan(request);
    const histories = new Map<string, LoadedHistory>();
    const limitations = [...plan.limitations];

    for (const instrumentId of plan.historySubjects) {
      let result: DailyHistoryResult;
      let bars: NormalizedDailyBar[] | undefined;
      let artifactId: string | undefined;
      let firstObservedAt: string | undefined;
      try {
        result = await this.history.loadDailyHistory({ instrumentId, observationCutoff: plan.request.observationCutoff, minimumSessions: 251 });
      } catch (error) {
        if (hasErrorCode(error, "UPSTREAM_SCHEMA_CHANGED")) throw new Error("RESEARCH_HISTORY_INTEGRITY_FAILURE");
        if (!isRecoverableHistoryFailure(error)) throw error;
        limitations.push({ capability: "market_baselines", code: "HISTORY_PROVIDER_EXHAUSTED", subjectId: instrumentId, retryable: true, message: `Daily history is unavailable for ${instrumentId}` });
        const fallback = await this.selectStoredDailyHistory({ instrumentId, request: plan.request, knowledgeCutoff: startedAt, warning: "HISTORY_PROVIDER_EXHAUSTED", limitations });
        if (!fallback) continue;
        ({ result, bars, artifactId, firstObservedAt } = fallback);
      }
      if (!bars) {
        try {
          assertHistoryIntegrity(result, instrumentId);
          bars = canonicalBars(result.bars, plan.request.observationCutoff, plan.request.expectedLatestSessionDate);
        } catch {
          throw new Error("RESEARCH_HISTORY_INTEGRITY_FAILURE");
        }
        artifactId = await historyArtifactId(result, bars);
      }
      if (!artifactId) throw new Error("RESEARCH_HISTORY_INTEGRITY_FAILURE");
      if (!firstObservedAt && bars.length && this.artifactStore && this.artifactMode !== "disabled") {
        const candidate: ResearchArtifactCandidate = {
          kind: "normalized_daily_history.v1",
          subjectId: instrumentId,
          logicalKey: `${instrumentId}:normalized-daily-history:qfq`,
          provider: result.provider,
          providerVersion: result.providerVersion,
          sourceAsOf: closeIso(bars.at(-1)!.sessionDate),
          retrievedAt: result.retrievedAt,
          payload: { bars },
          rawPayload: { bars },
          warnings: result.warnings,
        };
        try {
          const captured = (await this.artifactStore.capture({ candidates: [candidate] })).artifacts[0];
          if (!captured) throw new ResearchArtifactStoreError("ARTIFACT_PERSISTENCE_FAILED");
          if (this.artifactMode === "required") {
            artifactId = captured.artifactId;
            firstObservedAt = captured.firstObservedAt;
          }
        } catch (error) {
          if (error instanceof ResearchArtifactStoreError && error.code === "RESEARCH_ARTIFACT_INTEGRITY_FAILURE") throw error;
          if (this.artifactMode === "required") {
            const code = error instanceof ResearchArtifactStoreError ? error.code : "ARTIFACT_PERSISTENCE_FAILED";
            limitations.push({ capability: "market_baselines", code, subjectId: instrumentId, retryable: true, message: `${instrumentId} daily history could not be persisted` });
            const fallback = await this.selectStoredDailyHistory({ instrumentId, request: plan.request, knowledgeCutoff: startedAt, warning: code, limitations });
            if (!fallback) continue;
            ({ result, bars, artifactId, firstObservedAt } = fallback);
          }
        }
      }
      const providerWarnings = result.warnings ?? [];
      const actualSessionDate = bars.at(-1)?.sessionDate;
      if (plan.request.expectedLatestSessionDate && actualSessionDate && actualSessionDate < plan.request.expectedLatestSessionDate) {
        const affectedBaselines = [
          ...(plan.request.instrumentIds.includes(instrumentId) ? [{ subjectId: instrumentId }] : []),
          ...plan.mappings
            .filter((mapping) => mapping.benchmarkInstrumentId === instrumentId)
            .map((mapping) => ({ subjectId: mapping.instrumentId, baselineType: "relative_return" as const })),
        ];
        for (const affected of affectedBaselines) limitations.push({
          capability: "market_baselines",
          code: "LATEST_SESSION_MISSING",
          ...affected,
          expectedSessionDate: plan.request.expectedLatestSessionDate,
          actualSessionDate,
          retryable: false,
          message: `${instrumentId} daily history ends at ${actualSessionDate}, before expected session ${plan.request.expectedLatestSessionDate}`,
        });
        result = { ...result, warnings: [...new Set([...providerWarnings, "LATEST_SESSION_MISSING"])] };
      }
      histories.set(instrumentId, { result, bars, artifactId, ...(firstObservedAt ? { firstObservedAt } : {}) });
      for (const warning of providerWarnings) {
        if (!limitations.some((limitation) => limitation.capability === "market_baselines" && limitation.subjectId === instrumentId && limitation.code === warning)) {
          limitations.push({ capability: "market_baselines", code: warning, subjectId: instrumentId, retryable: false, message: `${instrumentId} daily history is degraded: ${warning}` });
        }
      }
    }

    const generatedAt = this.now();
    const knowledgeCutoff = researchKnowledgeCutoff(plan.request.observationCutoff, [...histories.values()].flatMap((history) => [history.result.retrievedAt, ...(history.firstObservedAt ? [history.firstObservedAt] : [])]));
    if (Date.parse(knowledgeCutoff) > Date.parse(generatedAt)) throw new Error("RESEARCH_HISTORY_INTEGRITY_FAILURE");
    const mappingFacts = plan.mappings.map((mapping) => mappingFact(mapping, knowledgeCutoff));
    const baselineFacts: MarketBaselineFact[] = [];

    for (const instrumentId of plan.request.instrumentIds) {
      const loaded = histories.get(instrumentId);
      if (!loaded) continue;
      for (const window of WINDOWS) {
        const direct = directBaselineFacts(instrumentId, window, loaded);
        baselineFacts.push(...direct.facts);
        limitations.push(...direct.limitations);
      }

      if (plan.request.purpose === "relative_performance") {
        const mapping = plan.mappings.find((candidate) => candidate.instrumentId === instrumentId);
        const benchmark = mapping ? histories.get(mapping.benchmarkInstrumentId) : undefined;
        if (mapping && benchmark) {
          for (const window of WINDOWS) {
            const relative = relativeReturnFact(instrumentId, mapping.benchmarkInstrumentId, window, loaded, benchmark);
            if (relative.fact) baselineFacts.push(relative.fact);
            if (relative.limitation) limitations.push(relative.limitation);
          }
        } else if (mapping) {
          limitations.push({ capability: "market_baselines", code: "BENCHMARK_HISTORY_UNAVAILABLE", subjectId: instrumentId, baselineType: "relative_return", retryable: true, message: `Benchmark history is unavailable for ${mapping.benchmarkInstrumentId}` });
        }
      }
    }

    const facts: ResearchFact[] = [...mappingFacts, ...baselineFacts].sort(compareFacts);
    const capabilities = buildCapabilities(plan, facts, limitations, histories, knowledgeCutoff);
    const unsigned: Omit<ResearchFactBundle, "fingerprint"> = {
      schemaVersion: "research-facts.v2",
      planVersion: plan.planVersion,
      purpose: plan.request.purpose,
      observationCutoff: plan.request.observationCutoff,
      ...(plan.request.expectedLatestSessionDate ? { expectedLatestSessionDate: plan.request.expectedLatestSessionDate } : {}),
      knowledgeCutoff,
      generatedAt,
      instrumentIds: plan.request.instrumentIds,
      facts,
      capabilities,
    };
    return parseResearchFactBundle({ ...unsigned, fingerprint: await calculateResearchFactBundleFingerprint(unsigned) });
  }

  private async selectStoredDailyHistory(input: {
    instrumentId: string;
    request: PreparedResearchFactPlan["request"];
    knowledgeCutoff: string;
    warning: string;
    limitations: InternalLimitation[];
  }): Promise<LoadedHistory | null> {
    if (!this.artifactStore || this.artifactMode === "disabled") return null;
    let artifacts: ResearchArtifact[];
    try {
      artifacts = (await this.artifactStore.selectAsOf({
        subjectIds: [input.instrumentId],
        kinds: ["normalized_daily_history.v1"],
        observationCutoff: input.request.observationCutoff,
        knowledgeCutoff: input.knowledgeCutoff,
      })).artifacts;
    } catch (error) {
      if (error instanceof ResearchArtifactStoreError && error.code === "RESEARCH_ARTIFACT_INTEGRITY_FAILURE") throw error;
      const code = error instanceof ResearchArtifactStoreError ? error.code : "ARTIFACT_STORE_UNAVAILABLE";
      input.limitations.push({ capability: "market_baselines", code, subjectId: input.instrumentId, retryable: true, message: `${input.instrumentId} stored daily history could not be selected` });
      return null;
    }
    const artifact = artifacts.find((candidate) => candidate.logicalKey === `${input.instrumentId}:normalized-daily-history:qfq`);
    if (!artifact) return null;
    try {
      if (artifact.kind !== "normalized_daily_history.v1" || artifact.subjectId !== input.instrumentId || !isRecord(artifact.payload) || !Array.isArray(artifact.payload.bars)) throw new Error("invalid stored history");
      const result: DailyHistoryResult = {
        instrumentId: artifact.subjectId,
        provider: artifact.provider,
        providerVersion: artifact.providerVersion,
        retrievedAt: artifact.retrievedAt,
        bars: artifact.payload.bars as NormalizedDailyBar[],
        warnings: [...new Set([...artifact.warnings, input.warning])],
      };
      assertHistoryIntegrity(result, input.instrumentId);
      const bars = canonicalBars(result.bars, input.request.observationCutoff, input.request.expectedLatestSessionDate);
      return { result, bars, artifactId: artifact.artifactId, firstObservedAt: artifact.firstObservedAt };
    } catch {
      throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    }
  }

  private async materializeCompanyUpdate(request: ResearchFactRequest & { purpose: "company_update" }): Promise<ResearchFactBundle> {
    const limitations: ResearchCapabilityLimitation[] = [];
    if (!this.artifactStore || !this.financialStatements || this.artifactMode !== "required") {
      limitations.push({ code: "ARTIFACT_STORE_UNAVAILABLE", retryable: true });
    } else {
      for (const instrumentId of request.instrumentIds) {
        try {
          const batch = await this.financialStatements.loadArtifacts({ instrumentId, observationCutoff: request.observationCutoff });
          if (batch.candidates.length) await this.artifactStore.capture(batch);
          else limitations.push({ code: "FINANCIAL_REPORT_NOT_FOUND", subjectId: instrumentId, retryable: false });
        } catch (error) {
          if (error instanceof FinancialStatementProviderError && error.code === "FINANCIAL_STATEMENT_INTEGRITY_FAILURE") throw error;
          if (error instanceof ResearchArtifactStoreError && error.code === "RESEARCH_ARTIFACT_INTEGRITY_FAILURE") throw error;
          const code = error instanceof ResearchArtifactStoreError ? error.code
            : error instanceof FinancialStatementProviderError ? error.code
              : "FINANCIAL_PROVIDER_EXHAUSTED";
          limitations.push({ code, subjectId: instrumentId, retryable: true });
        }
      }
    }
    const generatedAt = this.now();
    let snapshot = { observationCutoff: request.observationCutoff, knowledgeCutoff: generatedAt, artifacts: [] as ResearchArtifact[] };
    if (this.artifactStore && this.artifactMode === "required") {
      try {
        snapshot = await this.artifactStore.selectAsOf({
          subjectIds: request.instrumentIds,
          kinds: ["financial_statement.v1", "official_filing_identity.v1"],
          observationCutoff: request.observationCutoff,
          knowledgeCutoff: generatedAt,
        });
      } catch (error) {
        if (error instanceof ResearchArtifactStoreError && error.code === "RESEARCH_ARTIFACT_INTEGRITY_FAILURE") throw error;
        limitations.push({ code: error instanceof ResearchArtifactStoreError ? error.code : "ARTIFACT_STORE_UNAVAILABLE", retryable: true });
      }
    }
    const knowledgeCutoff = researchKnowledgeCutoff(request.observationCutoff, snapshot.artifacts.flatMap((artifact) => [artifact.firstObservedAt, artifact.retrievedAt]));
    if (Date.parse(knowledgeCutoff) > Date.parse(generatedAt)) throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    snapshot = { ...snapshot, knowledgeCutoff };
    const built = buildCompanyUpdateFacts({ snapshot, instrumentIds: request.instrumentIds, initialLimitations: limitations, retrievedAt: knowledgeCutoff });
    const unsigned: Omit<ResearchFactBundle, "fingerprint"> = {
      schemaVersion: "research-facts.v2",
      planVersion: "company-update.v1",
      purpose: "company_update",
      observationCutoff: request.observationCutoff,
      ...(request.expectedLatestSessionDate ? { expectedLatestSessionDate: request.expectedLatestSessionDate } : {}),
      knowledgeCutoff,
      generatedAt,
      instrumentIds: request.instrumentIds,
      facts: built.facts,
      capabilities: [built.capability],
    };
    return parseResearchFactBundle({ ...unsigned, fingerprint: await calculateResearchFactBundleFingerprint(unsigned) });
  }
}

function directBaselineFacts(instrumentId: string, window: MarketBaselineWindow, loaded: LoadedHistory): { facts: MarketBaselineFact[]; limitations: PreparedResearchFactPlan["limitations"] } {
  const facts: MarketBaselineFact[] = [];
  const limitations: PreparedResearchFactPlan["limitations"] = [];
  const historyWarnings = loaded.result.warnings ?? [];
  const volumeBars = loaded.bars.slice(-window);
  const returnBars = loaded.bars.slice(-(window + 1));

  if (volumeBars.length === window) {
    const volumes = volumeBars.map((bar) => decimal(bar.volume, "volume"));
    facts.push(makeBaselineFact({ instrumentId, type: "volume_median", window, bars: volumeBars, value: median(volumes), unit: "shares", loaded, required: window, warnings: historyWarnings }));
  } else limitations.push(insufficient(instrumentId, "volume_median", window, volumeBars.length, window));

  if (returnBars.length === window + 1) {
    const closes = returnBars.map((bar) => decimal(bar.close, "close"));
    const priceReturn = closes.at(-1)! / closes[0] - 1;
    const logReturns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
    const realizedVolatility = logReturns.length < 2 ? 0 : standardDeviation(logReturns) * Math.sqrt(250);
    facts.push(makeBaselineFact({ instrumentId, type: "price_return", window, bars: returnBars, value: priceReturn, unit: "ratio", loaded, required: window + 1, warnings: historyWarnings }));
    facts.push(makeBaselineFact({ instrumentId, type: "realized_volatility", window, bars: returnBars, value: realizedVolatility, unit: "ratio", loaded, required: window + 1, warnings: historyWarnings }));
  } else {
    limitations.push(insufficient(instrumentId, "price_return", window, returnBars.length, window + 1));
    limitations.push(insufficient(instrumentId, "realized_volatility", window, returnBars.length, window + 1));
  }
  return { facts, limitations };
}

function relativeReturnFact(instrumentId: string, benchmarkId: string, window: MarketBaselineWindow, subject: LoadedHistory, benchmark: LoadedHistory): { fact?: MarketBaselineFact; limitation?: PreparedResearchFactPlan["limitations"][number] } {
  const benchmarkByDate = new Map(benchmark.bars.map((bar) => [bar.sessionDate, bar] as const));
  const aligned = subject.bars.flatMap((bar) => {
    const benchmarkBar = benchmarkByDate.get(bar.sessionDate);
    return benchmarkBar ? [{ subject: bar, benchmark: benchmarkBar }] : [];
  }).slice(-(window + 1));
  if (aligned.length < window + 1) return { limitation: insufficient(instrumentId, "relative_return", window, aligned.length, window + 1) };
  const subjectReturn = decimal(aligned.at(-1)!.subject.close, "close") / decimal(aligned[0].subject.close, "close") - 1;
  const benchmarkReturn = decimal(aligned.at(-1)!.benchmark.close, "close") / decimal(aligned[0].benchmark.close, "close") - 1;
  const bars = aligned.map((item) => item.subject);
  const warnings = [...new Set([...(subject.result.warnings ?? []), ...(benchmark.result.warnings ?? [])])];
  const provenance = mergeProvenance(subject, benchmark, bars.at(-1)!.sessionDate);
  return {
    fact: {
      id: factId(instrumentId, "relative_return", window, bars.at(-1)!.sessionDate, benchmarkId),
      kind: "market_baseline",
      subjectId: instrumentId,
      baselineType: "relative_return",
      window,
      benchmarkId,
      observationPeriod: { start: closeIso(bars[1].sessionDate), end: closeIso(bars.at(-1)!.sessionDate), tradingSessions: window },
      value: { decimal: format(subjectReturn - benchmarkReturn), unit: "ratio" },
      formula: formula("relative_return", window, [subject.artifactId, benchmark.artifactId]),
      provenance,
      quality: quality(window + 1, window + 1, warnings),
    },
  };
}

function makeBaselineFact(input: { instrumentId: string; type: Exclude<MarketBaselineType, "relative_return">; window: MarketBaselineWindow; bars: NormalizedDailyBar[]; value: number; unit: "ratio" | "shares"; loaded: LoadedHistory; required: number; warnings: string[] }): MarketBaselineFact {
  const startIndex = input.type === "volume_median" ? 0 : 1;
  const sourceAsOf = closeIso(input.bars.at(-1)!.sessionDate);
  return {
    id: factId(input.instrumentId, input.type, input.window, input.bars.at(-1)!.sessionDate),
    kind: "market_baseline",
    subjectId: input.instrumentId,
    baselineType: input.type,
    window: input.window,
    observationPeriod: { start: closeIso(input.bars[startIndex].sessionDate), end: sourceAsOf, tradingSessions: input.window },
    value: { decimal: format(input.value), unit: input.unit },
    formula: formula(input.type, input.window, [input.loaded.artifactId]),
    provenance: provenance(input.loaded, sourceAsOf),
    quality: quality(input.required, input.required, input.warnings),
  };
}

function mappingFact(mapping: BenchmarkMapping, generatedAt: string): InstrumentMappingFact {
  const artifactId = `mapping:${mapping.instrumentId}:${mapping.benchmarkInstrumentId}:${mapping.methodologyVersion}`;
  return {
    id: artifactId,
    kind: "instrument_mapping",
    subjectId: mapping.instrumentId,
    mappingType: "benchmark",
    targetId: mapping.benchmarkInstrumentId,
    validFrom: mapping.validFrom,
    validTo: mapping.validTo,
    methodologyVersion: mapping.methodologyVersion,
    provenance: { providers: [mapping.source], sourceArtifactIds: [artifactId], sourceAsOf: mapping.validFrom, retrievedAt: generatedAt },
    quality: quality(1, 1, []),
  };
}

function buildCapabilities(plan: PreparedResearchFactPlan, facts: ResearchFact[], limitations: PreparedResearchFactPlan["limitations"], histories: Map<string, LoadedHistory>, generatedAt: string): ResearchCapabilityOutcome[] {
  const result: ResearchCapabilityOutcome[] = [];
  const latestAsOf = latest([...histories.values()].flatMap((history) => history.bars.map((bar) => closeIso(bar.sessionDate))));
  if (plan.request.purpose === "relative_performance") {
    const mappingFacts = facts.filter((fact): fact is InstrumentMappingFact => fact.kind === "instrument_mapping");
    const mappingIds = mappingFacts.map((fact) => fact.id);
    const mappingLimitations = limitations.filter((item) => item.capability === "instrument_mapping");
    result.push(capability("instrument_mapping", true, mappingIds, mappingLimitations, latest(mappingFacts.map((fact) => fact.provenance.sourceAsOf)), generatedAt));
  }
  const baselineIds = facts.filter((fact) => fact.kind === "market_baseline").map((fact) => fact.id);
  const baselineLimitations = limitations.filter((item) => item.capability === "market_baselines");
  result.push(capability("market_baselines", true, baselineIds, baselineLimitations, latestAsOf, generatedAt));
  return result;
}

function capability(id: "instrument_mapping" | "market_baselines", required: boolean, factIds: string[], limitations: PreparedResearchFactPlan["limitations"], asOf: string | null, retrievedAt: string): ResearchCapabilityOutcome {
  const projected = limitations.map(projectLimitation);
  if (!factIds.length) {
    const unavailableLimitations = projected.length ? projected : [{ code: "NO_FACTS_MATERIALIZED", retryable: false }];
    return { id, required, status: "unavailable", factIds: [], asOf: null, retrievedAt, warnings: [...new Set(unavailableLimitations.map((item) => item.code))].sort(), limitations: unavailableLimitations, error: { code: unavailableLimitations[0].code, retryable: unavailableLimitations.some((item) => item.retryable) } };
  }
  return { id, required, status: limitations.length ? "degraded" : "operational", factIds: [...factIds].sort(), asOf, retrievedAt, warnings: [...new Set(limitations.map((item) => item.code))].sort(), limitations: projected };
}

function projectLimitation({ capability: _capability, message: _message, ...limitation }: InternalLimitation): ResearchCapabilityLimitation { return limitation; }

function formula(type: MarketBaselineType, window: MarketBaselineWindow, inputArtifactIds: string[]) {
  const expressions: Record<MarketBaselineType, string> = {
    price_return: "close[t] / close[t-window] - 1",
    volume_median: "median(volume[t-window+1..t])",
    realized_volatility: "sample_stddev(ln(close[t]/close[t-1])) * sqrt(250)",
    relative_return: "subject_return - benchmark_return",
  };
  return { id: `market.${type}.v1`, version: "1", expression: expressions[type], inputArtifactIds, parameters: { window: String(window), annualizationSessions: "250", adjustment: "qfq" }, rounding: "decimal-12-nearest" };
}

function provenance(history: LoadedHistory, sourceAsOf: string): FactProvenance {
  return { providers: [history.result.provider], sourceArtifactIds: [history.artifactId], sourceAsOf, retrievedAt: history.result.retrievedAt };
}

function mergeProvenance(subject: LoadedHistory, benchmark: LoadedHistory, sessionDate: string): FactProvenance {
  return { providers: [...new Set([subject.result.provider, benchmark.result.provider])].sort(), sourceArtifactIds: [subject.artifactId, benchmark.artifactId].sort(), sourceAsOf: closeIso(sessionDate), retrievedAt: latest([subject.result.retrievedAt, benchmark.result.retrievedAt])! };
}

function quality(actual: number, required: number, warnings: string[]) {
  const uniqueWarnings = [...new Set(warnings)].sort();
  return { status: uniqueWarnings.length ? "degraded" as const : "operational" as const, reliable: uniqueWarnings.length === 0 && actual >= required, coverage: { actual, required }, warnings: uniqueWarnings };
}

function insufficient(instrumentId: string, type: MarketBaselineType, window: MarketBaselineWindow, actual: number, required: number): PreparedResearchFactPlan["limitations"][number] {
  return { capability: "market_baselines", code: "INSUFFICIENT_SAMPLE", subjectId: instrumentId, baselineType: type, window, actual, required, retryable: false, message: `${instrumentId} ${type}:${window} has ${actual}/${required} required daily observations` };
}

function canonicalBars(input: NormalizedDailyBar[], observationCutoff: string, expectedLatestSessionDate?: string): NormalizedDailyBar[] {
  const bySession = new Map<string, NormalizedDailyBar>();
  for (const bar of input) {
    if (!bar || typeof bar !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(bar.sessionDate) || typeof bar.close !== "string" || typeof bar.volume !== "string" || (bar.turnover !== null && typeof bar.turnover !== "string")) throw new Error("INVALID_DAILY_BAR_STRUCTURE");
    if (Date.parse(closeIso(bar.sessionDate)) > Date.parse(observationCutoff)) continue;
    if (expectedLatestSessionDate && bar.sessionDate > expectedLatestSessionDate) continue;
    decimal(bar.close, "close");
    decimal(bar.volume, "volume");
    if (bar.turnover !== null) decimal(bar.turnover, "turnover");
    if (bySession.has(bar.sessionDate)) throw new Error("DUPLICATE_DAILY_BAR_SESSION");
    bySession.set(bar.sessionDate, bar);
  }
  return [...bySession.values()].sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
}

function assertHistoryIntegrity(history: DailyHistoryResult, expectedInstrumentId: string): void {
  if (!history || typeof history !== "object" || history.instrumentId !== expectedInstrumentId || !Array.isArray(history.bars)) throw new Error("HISTORY_SUBJECT_MISMATCH");
  if (!history.provider || !history.providerVersion || Number.isNaN(Date.parse(history.retrievedAt))) throw new Error("INVALID_HISTORY_PROVENANCE");
  if (history.warnings !== undefined && (!Array.isArray(history.warnings) || history.warnings.some((warning) => typeof warning !== "string"))) throw new Error("INVALID_HISTORY_WARNINGS");
}

function isRecoverableHistoryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ALL_PROVIDERS_FAILED" || code === "HISTORY_PROVIDER_EXHAUSTED" || code === "HISTORY_PROVIDER_TRANSPORT";
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === expected);
}

function mappingIsEffective(mapping: BenchmarkMapping, cutoff: string): boolean {
  return mapping.instrumentId.length > 0
    && /^(SSE|SZSE):\d{6}$/.test(mapping.benchmarkInstrumentId)
    && !Number.isNaN(Date.parse(mapping.validFrom))
    && Date.parse(mapping.validFrom) <= Date.parse(cutoff)
    && (mapping.validTo === null || Date.parse(mapping.validTo) > Date.parse(cutoff));
}

async function historyArtifactId(history: DailyHistoryResult, bars: NormalizedDailyBar[]): Promise<string> {
  return `daily-bars:${history.instrumentId}:${await sha256(stableJson({ providerVersion: history.providerVersion, bars }))}`;
}
function factId(instrumentId: string, type: MarketBaselineType, window: MarketBaselineWindow, sessionDate: string, benchmarkId?: string): string {
  return `baseline:${instrumentId}:${type}:${String(window).padStart(3, "0")}:${sessionDate}${benchmarkId ? `:${benchmarkId}` : ""}`;
}
function closeIso(sessionDate: string): string { return `${sessionDate}T07:00:00.000Z`; }
function decimal(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (field === "close" && parsed === 0)) throw new Error(`INVALID_${field.toUpperCase()}`);
  return parsed;
}
function mean(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : mean([sorted[midpoint - 1], sorted[midpoint]]);
}
function standardDeviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}
function format(value: number): string {
  const normalized = Number(value.toFixed(12));
  return Object.is(normalized, -0) ? "0" : String(normalized);
}
function latest(values: string[]): string | null { return [...values].sort().at(-1) ?? null; }
function researchKnowledgeCutoff(observationCutoff: string, artifactTimes: string[]): string {
  return latest([observationCutoff, ...artifactTimes])!;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function compareFacts(left: ResearchFact, right: ResearchFact): number {
  const subject = left.subjectId.localeCompare(right.subjectId);
  if (subject) return subject;
  if (left.kind !== "market_baseline" || right.kind !== "market_baseline") return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
  return BASELINE_ORDER.indexOf(left.baselineType) - BASELINE_ORDER.indexOf(right.baselineType) || left.window - right.window;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
