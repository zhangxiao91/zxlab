import type {
  AskScope,
  EvidenceItem,
  MarketAgentCommand,
  SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";

const MAX_CONTEXT_ITEMS = 80;
const MAX_CONTEXT_EVIDENCE_BYTES = 48 * 1024;

type ClaimPolicy = "live-if-fresh" | "last-observed-not-live" | "current-price-claims-forbidden";

export interface NarrationContext {
  version: "narration-context.v1";
  source: {
    evidenceFingerprint: string;
    schemaVersion: string;
    eventRuleVersion: string;
    workflow: MarketAgentCommand["workflow"];
    sealedAt: string;
    instrumentIds: string[];
    contextUses: SealedEvidenceBundle["contextUses"];
  };
  focus: {
    askScope: AskScope | null;
    selectedInstrumentId: string | null;
    strategy: string;
  };
  marketState: {
    sessions: string[];
    claimPolicy: ClaimPolicy;
    quality: {
      status: string;
      reliable: boolean;
      freshness: string;
      warnings: string[];
      unavailableCapabilities: string[];
    };
    markets: unknown[];
    capabilityIssues: unknown[];
    guidance: string[];
  };
  derived: {
    quoteBreadth?: Record<string, unknown>;
  };
  evidence: Array<Pick<EvidenceItem, "id" | "kind" | "origin" | "reliable"> & { value: Record<string, unknown> }>;
  selection: {
    sourceItems: number;
    includedItems: number;
    omittedItems: number;
    omittedByBudget: number;
    maxItems: number;
    evidenceByteBudget: number;
  };
}

/**
 * Builds the single bounded, scope-aware projection used by every narrator adapter.
 * The sealed bundle remains authoritative; every projected item retains its original
 * evidence ID so output validation still runs against the full bundle.
 */
export function buildNarrationContext(input: {
  evidence: SealedEvidenceBundle;
  workflow: MarketAgentCommand["workflow"];
  askScope?: AskScope;
}): NarrationContext {
  const selectedInstrumentId = selectedInstrument(input.evidence);
  const marketState = describeMarketState(input.evidence);
  const breadth = quoteBreadth(input.evidence, selectedInstrumentId);
  const candidates = input.evidence.items
    .map((item, index) => ({ item, index, score: evidencePriority(item, input.askScope, selectedInstrumentId) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const projected: NarrationContext["evidence"] = [];
  let projectedBytes = 0;
  let omittedByBudget = 0;

  for (const candidate of candidates) {
    if (projected.length >= MAX_CONTEXT_ITEMS) {
      omittedByBudget += 1;
      continue;
    }
    const compact = compactEvidenceItem(candidate.item);
    const bytes = byteLength(compact);
    if (projectedBytes + bytes > MAX_CONTEXT_EVIDENCE_BYTES) {
      omittedByBudget += 1;
      continue;
    }
    projected.push(compact);
    projectedBytes += bytes;
  }

  return {
    version: "narration-context.v1",
    source: {
      evidenceFingerprint: input.evidence.fingerprint,
      schemaVersion: input.evidence.schemaVersion,
      eventRuleVersion: input.evidence.eventRuleVersion,
      workflow: input.workflow,
      sealedAt: input.evidence.sealedAt,
      instrumentIds: input.evidence.instrumentIds,
      contextUses: input.evidence.contextUses,
    },
    focus: {
      askScope: input.askScope ?? input.evidence.ask?.scope ?? null,
      selectedInstrumentId,
      strategy: selectionStrategy(input.askScope ?? input.evidence.ask?.scope),
    },
    marketState,
    derived: {
      ...(breadth ? { quoteBreadth: breadth } : {}),
    },
    evidence: projected,
    selection: {
      sourceItems: input.evidence.items.length,
      includedItems: projected.length,
      omittedItems: input.evidence.items.length - projected.length,
      omittedByBudget,
      maxItems: MAX_CONTEXT_ITEMS,
      evidenceByteBudget: MAX_CONTEXT_EVIDENCE_BYTES,
    },
  };
}

function describeMarketState(evidence: SealedEvidenceBundle): NarrationContext["marketState"] {
  const context = snapshotContext(evidence);
  const qualityRecord = record(context?.quality);
  const quality = {
    status: stringValue(qualityRecord?.status) ?? (evidence.items.some((item) => !item.reliable) ? "degraded" : "unknown"),
    reliable: typeof qualityRecord?.reliable === "boolean"
      ? qualityRecord.reliable
      : !evidence.items.some((item) => item.kind === "market_fact" && !item.reliable),
    freshness: stringValue(qualityRecord?.freshness) ?? "unknown",
    warnings: stringArray(qualityRecord?.warnings, 24),
    unavailableCapabilities: stringArray(qualityRecord?.unavailableCapabilities, 48),
  };
  const markets = Array.isArray(context?.markets) ? context.markets.map((value) => bounded(value, 0, 24)) : inferredMarkets(evidence);
  const sessions = [...new Set(markets.flatMap((market) => {
    const session = stringValue(record(market)?.session);
    return session ? [session] : [];
  }))].sort();
  const capabilities = Array.isArray(context?.capabilities) ? context.capabilities : [];
  const capabilityIssues = capabilities
    .filter((capability) => {
      const value = record(capability);
      return value && (value.status !== "operational" || value.freshness === "stale" || value.freshness === "unknown");
    })
    .slice(0, 48)
    .map((value) => bounded(value, 0, 16));
  const claimPolicy = marketClaimPolicy(sessions, quality);
  return {
    sessions,
    claimPolicy,
    quality,
    markets,
    capabilityIssues,
    guidance: claimGuidance(claimPolicy, sessions, capabilityIssues.length > 0),
  };
}

function marketClaimPolicy(
  sessions: string[],
  quality: NarrationContext["marketState"]["quality"],
): ClaimPolicy {
  if (!quality.reliable || quality.freshness === "stale" || quality.freshness === "unknown" || sessions.includes("unknown") || sessions.length === 0) {
    return "current-price-claims-forbidden";
  }
  if (sessions.length === 1 && sessions[0] === "open" && quality.freshness === "fresh") return "live-if-fresh";
  return "last-observed-not-live";
}

function claimGuidance(policy: ClaimPolicy, sessions: string[], partialCapabilities: boolean): string[] {
  const guidance = policy === "live-if-fresh"
    ? ["Only reliable, non-stale quote items may be described as current during the open session."]
    : policy === "last-observed-not-live"
      ? ["Describe prices as last observed or prior-close references; do not call them live or current."]
      : ["Do not make current-price claims. State what is unknown and cite the relevant limitation or unreliable fact."];
  if (sessions.includes("preopen")) guidance.push("Pre-open evidence must not be described as an intraday move.");
  if (sessions.includes("break")) guidance.push("Break-session prices are the last observations before the pause.");
  if (sessions.includes("closed") || sessions.includes("holiday")) guidance.push("Closed or holiday evidence is historical even when it is the latest valid market observation.");
  if (partialCapabilities) guidance.push("Answer only from available capabilities and name material missing or stale capabilities.");
  return guidance;
}

function compactEvidenceItem(item: EvidenceItem): NarrationContext["evidence"][number] {
  const value = record(item.value);
  return {
    id: item.id,
    kind: item.kind,
    origin: item.origin,
    reliable: item.reliable,
    value: compactEvidenceValue(value),
  };
}

function compactEvidenceValue(value: Record<string, unknown> | null): Record<string, unknown> {
  if (!value) return { type: "unknown", value: bounded(value, 0, 8) };
  if (value.type === "bar_series") return compactBarSeries(value);
  if (value.type === "quote") return compactQuote(value);
  if (value.type === "snapshot_context") return compactSnapshotContext(value);
  if (value.evidenceType === "news" || value.evidenceType === "announcement") return compactExternalText(value);
  if (value.type === "portfolio_snapshot") return compactPortfolioSnapshot(value);
  if (value.type === "previous_run") return compactPreviousRun(value);
  return bounded(value, 0, 32) as Record<string, unknown>;
}

function compactBarSeries(value: Record<string, unknown>): Record<string, unknown> {
  const bars = Array.isArray(value.bars) ? value.bars.flatMap((bar) => record(bar) ? [record(bar)!] : []) : [];
  const first = bars[0] ?? null;
  const previous = bars.length > 1 ? bars.at(-2) ?? null : null;
  const latest = bars.at(-1) ?? null;
  const highs = bars.flatMap((bar) => finite(bar.high) === null ? [] : [finite(bar.high)!]);
  const lows = bars.flatMap((bar) => finite(bar.low) === null ? [] : [finite(bar.low)!]);
  const volumes = bars.flatMap((bar) => finite(bar.volume) === null ? [] : [finite(bar.volume)!]);
  const firstClose = finite(first?.close);
  const latestClose = finite(latest?.close);
  return {
    type: "bar_series_summary",
    instrumentId: stringValue(value.instrumentId),
    interval: stringValue(value.interval),
    barCount: bars.length,
    windowStart: stringValue(first?.timestamp),
    windowEnd: stringValue(latest?.timestamp),
    first: compactBar(first),
    previous: compactBar(previous),
    latest: compactBar(latest),
    rangeHigh: highs.length ? Math.max(...highs) : null,
    rangeLow: lows.length ? Math.min(...lows) : null,
    totalVolume: volumes.length ? volumes.reduce((sum, volume) => sum + volume, 0) : null,
    windowChangePct: firstClose !== null && latestClose !== null && firstClose !== 0
      ? round(100 * (latestClose - firstClose) / firstClose, 4)
      : null,
    trailingCloses: bars.slice(-8).map((bar) => ({ timestamp: stringValue(bar.timestamp), close: finite(bar.close) })),
  };
}

function compactBar(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    timestamp: stringValue(value.timestamp),
    open: finite(value.open),
    high: finite(value.high),
    low: finite(value.low),
    close: finite(value.close),
    volume: finite(value.volume),
    turnover: finite(value.turnover),
  };
}

function compactQuote(value: Record<string, unknown>): Record<string, unknown> {
  const corroboration = record(value.corroboration);
  return {
    type: "quote",
    instrumentId: stringValue(value.instrumentId),
    price: finite(value.price),
    previousClose: finite(value.previousClose),
    open: finite(value.open),
    high: finite(value.high),
    low: finite(value.low),
    volume: finite(value.volume),
    turnover: finite(value.turnover),
    marketTimestamp: stringValue(value.marketTimestamp),
    receivedAt: stringValue(value.receivedAt),
    source: truncatedString(value.source, 120),
    quality: stringValue(value.quality),
    stale: value.stale === true,
    fallbackUsed: value.fallbackUsed === true,
    warnings: stringArray(value.warnings, 16),
    corroboration: corroboration ? {
      mode: stringValue(corroboration.mode),
      status: stringValue(corroboration.status),
      thresholdBps: finite(corroboration.thresholdBps),
      maxDeviationBps: finite(corroboration.maxDeviationBps),
      observations: Array.isArray(corroboration.observations)
        ? corroboration.observations.slice(0, 4).map((entry) => bounded(entry, 0, 10))
        : [],
    } : null,
    providerAttempts: Array.isArray(value.providerAttempts)
      ? value.providerAttempts.slice(0, 6).map((entry) => bounded(entry, 0, 10))
      : [],
  };
}

function compactSnapshotContext(value: Record<string, unknown>): Record<string, unknown> {
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
  const issues = capabilities.filter((capability) => capability.status !== "operational" || capability.freshness === "stale" || capability.freshness === "unknown");
  return {
    type: "snapshot_context",
    asOf: stringValue(value.asOf),
    receivedAt: stringValue(value.receivedAt),
    marketTimestamp: stringValue(value.marketTimestamp),
    quality: bounded(value.quality, 0, 24),
    markets: Array.isArray(value.markets) ? value.markets.slice(0, 4).map((entry) => bounded(entry, 0, 24)) : [],
    capabilitySummary: {
      total: capabilities.length,
      operational: capabilities.filter((item) => item.status === "operational").length,
      degraded: capabilities.filter((item) => item.status === "degraded").length,
      unavailable: capabilities.filter((item) => item.status === "unavailable").length,
      stale: capabilities.filter((item) => item.freshness === "stale").length,
      issues: issues.slice(0, 48).map((entry) => bounded(entry, 0, 16)),
    },
  };
}

function compactExternalText(value: Record<string, unknown>): Record<string, unknown> {
  return {
    evidenceType: value.evidenceType,
    id: truncatedString(value.id, 160),
    type: stringValue(value.type),
    title: truncatedString(value.title, 300),
    summary: truncatedString(value.summary, 1_000),
    contentExcerpt: truncatedString(value.content, 1_500),
    source: truncatedString(value.source, 160),
    publishedAt: stringValue(value.publishedAt),
    receivedAt: stringValue(value.receivedAt),
    instrumentId: stringValue(value.instrumentId),
    url: truncatedString(value.url, 600),
    warnings: stringArray(value.warnings, 16),
    untrustedExternalText: true,
  };
}

function compactPortfolioSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const positions = Array.isArray(value.positions) ? value.positions : [];
  return {
    type: "portfolio_snapshot",
    id: truncatedString(value.id, 160),
    sourceRevision: truncatedString(value.sourceRevision, 160),
    calculatedAt: stringValue(value.calculatedAt),
    effectiveAt: stringValue(value.effectiveAt),
    expiresAt: stringValue(value.expiresAt),
    cash: finite(value.cash),
    rulesVersion: truncatedString(value.rulesVersion, 160),
    positionCount: positions.length,
    positions: positions.slice(0, 40).map((position) => bounded(position, 0, 8)),
    omittedPositions: Math.max(0, positions.length - 40),
    warnings: stringArray(value.warnings, 16),
  };
}

function compactPreviousRun(value: Record<string, unknown>): Record<string, unknown> {
  const result = record(value.result);
  return {
    type: "previous_run",
    runId: truncatedString(value.runId, 160),
    workflow: stringValue(value.workflow),
    createdAt: stringValue(value.createdAt),
    evidenceFingerprint: truncatedString(value.evidenceFingerprint, 160),
    result: result ? {
      status: result.status,
      headline: truncatedString(result.headline, 300),
      summary: truncatedString(result.summary, 1_500),
      observations: Array.isArray(result.observations) ? result.observations.slice(0, 16).map((entry) => bounded(entry, 0, 16)) : [],
      portfolioImpacts: Array.isArray(result.portfolioImpacts) ? result.portfolioImpacts.slice(0, 12).map((entry) => bounded(entry, 0, 16)) : [],
      watchNext: Array.isArray(result.watchNext) ? result.watchNext.slice(0, 12).map((entry) => bounded(entry, 0, 16)) : [],
      limitations: stringArray(result.limitations, 16),
    } : null,
  };
}

function evidencePriority(item: EvidenceItem, scope: AskScope | undefined, selectedInstrumentId: string | null): number {
  const value = record(item.value);
  const type = stringValue(value?.type);
  const evidenceType = stringValue(value?.evidenceType);
  const instrumentId = stringValue(value?.instrumentId);
  let score = type === "snapshot_context" ? 2_000
    : item.kind === "limitation" ? 1_900
      : item.kind === "execution_plan" ? 1_850
        : type === "market_status" ? 1_800
          : item.kind === "market_event" ? 1_500
            : item.kind === "portfolio_impact" ? 1_300
              : item.kind === "prior_run" ? 1_250
                : type === "quote" ? 1_100
                  : evidenceType === "news" || evidenceType === "announcement" ? 1_000
                    : type === "bar_series" ? 900
                      : 500;
  if (selectedInstrumentId && instrumentId === selectedInstrumentId) score += 350;
  if (scope === "data_quality" && (item.kind === "limitation" || type === "snapshot_context" || type === "market_status" || !item.reliable)) score += 800;
  if (scope === "news_and_announcements" && (evidenceType === "news" || evidenceType === "announcement")) score += 800;
  if (scope === "relative_performance" && type === "quote") score += 700 + Math.min(250, Math.abs(quoteMovePct(value)) * 10);
  if (scope === "portfolio_impact" && item.kind === "portfolio_impact") score += 800;
  if (scope === "compare_previous_run" && item.kind === "prior_run") score += 1_000;
  return score;
}

function selectedInstrument(evidence: SealedEvidenceBundle): string | null {
  for (const item of evidence.items) {
    const value = record(item.value);
    if (value?.type === "ask_plan") return stringValue(value.selectedInstrumentId);
  }
  return evidence.instrumentIds.length === 1 ? evidence.instrumentIds[0] : null;
}

function quoteBreadth(evidence: SealedEvidenceBundle, selectedInstrumentId: string | null): Record<string, unknown> | null {
  const observations = evidence.items.flatMap((item) => {
    const value = record(item.value);
    if (value?.type !== "quote") return [];
    const instrumentId = stringValue(value.instrumentId);
    const price = finite(value.price);
    const previousClose = finite(value.previousClose);
    if (!instrumentId || price === null || previousClose === null || previousClose === 0) return [];
    return [{ evidenceId: item.id, instrumentId, movePct: round(100 * (price - previousClose) / previousClose, 4), reliable: item.reliable }];
  });
  if (!observations.length) return null;
  const sorted = [...observations].sort((left, right) => right.movePct - left.movePct || left.instrumentId.localeCompare(right.instrumentId));
  const moves = sorted.map((item) => item.movePct).sort((left, right) => left - right);
  const middle = Math.floor(moves.length / 2);
  const median = moves.length % 2 ? moves[middle] : (moves[middle - 1] + moves[middle]) / 2;
  const selected = selectedInstrumentId ? sorted.find((item) => item.instrumentId === selectedInstrumentId) ?? null : null;
  return {
    observedCount: observations.length,
    reliableCount: observations.filter((item) => item.reliable).length,
    risingCount: observations.filter((item) => item.movePct > 0).length,
    fallingCount: observations.filter((item) => item.movePct < 0).length,
    flatCount: observations.filter((item) => item.movePct === 0).length,
    medianMovePct: round(median, 4),
    selected: selected ? { ...selected, rank: sorted.indexOf(selected) + 1 } : null,
    leaders: sorted.slice(0, 5),
    laggards: sorted.slice(-5).reverse(),
  };
}

function selectionStrategy(scope: AskScope | undefined): string {
  return {
    today_change: "session-and-selected-instrument-first",
    relative_performance: "selected-instrument-and-largest-relative-moves-first",
    news_and_announcements: "session-then-recent-external-material-first",
    data_quality: "quality-limitations-and-capability-issues-first",
    portfolio_impact: "quality-then-portfolio-impact-first",
    compare_previous_run: "quality-then-prior-run-delta-first",
  }[scope ?? "today_change"];
}

function snapshotContext(evidence: SealedEvidenceBundle): Record<string, unknown> | null {
  for (const item of evidence.items) {
    const value = record(item.value);
    if (value?.type === "snapshot_context") return value;
  }
  return null;
}

function inferredMarkets(evidence: SealedEvidenceBundle): unknown[] {
  return evidence.items.flatMap((item) => {
    const value = record(item.value);
    return value?.type === "market_status" ? [bounded(value, 0, 24)] : [];
  });
}

function quoteMovePct(value: Record<string, unknown> | null): number {
  const price = finite(value?.price);
  const previousClose = finite(value?.previousClose);
  return price !== null && previousClose !== null && previousClose !== 0 ? 100 * (price - previousClose) / previousClose : 0;
}

function bounded(value: unknown, depth: number, maxEntries: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 1_500 ? `${value.slice(0, 1_500)}…` : value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, maxEntries).map((entry) => bounded(entry, depth + 1, Math.max(8, Math.floor(maxEntries / 2))));
  const object = record(value);
  if (!object) return null;
  return Object.fromEntries(Object.entries(object).slice(0, maxEntries).map(([key, entry]) => [key, bounded(entry, depth + 1, Math.max(8, Math.floor(maxEntries / 2)))]));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function truncatedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function stringArray(value: unknown, maxItems: number): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? [item.slice(0, 500)] : []).slice(0, maxItems) : [];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
