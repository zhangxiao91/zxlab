import type { MarketSnapshot } from "@zxlab/market-schema";
import type { RiskImpact } from "@zxlab/risk-domain";
import type { AgentResult, AgentRun, EvidenceItem, MarketAgentAskCommand, MarketAgentCommand, MarketEvent, PortfolioSnapshot, RunClaimResult, RunCreation, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { EVENT_RULE_VERSION, MARKET_AGENT_SCHEMA_VERSION, eventEvidenceId, isMarketAgentAskCommand } from "@zxlab/market-agent-schema";
import type { AskEvidencePlan } from "./ask-plan.ts";

export interface EventDetectionRules { absoluteMoveBps: number; }

export class DeterministicMarketEventDetector {
  detect(input: { current: MarketSnapshot; previous?: MarketSnapshot; runId: string; rules?: EventDetectionRules }): MarketEvent[] {
    const threshold = input.rules?.absoluteMoveBps ?? 500;
    return input.current.data.quotes.flatMap((quote, index) => {
      if (!quote.price || !quote.previousClose || quote.quality === "unavailable" || quote.quality === "conflicted") return [];
      const moveBps = Math.round(((quote.price - quote.previousClose) / quote.previousClose) * 10000);
      if (Math.abs(moveBps) < threshold) return [];
      const id = eventEvidenceId(input.runId, index);
      return [{ id, ruleId: "price.absolute_move.v1", instrumentId: quote.instrumentId, kind: moveBps >= 0 ? "price_rise" : "price_fall", observedAt: quote.marketTimestamp ?? quote.receivedAt, actual: moveBps, threshold, reliable: quote.quality === "live" && !quote.stale, evidenceId: id, dedupeKey: `${quote.instrumentId}:price.absolute_move.v1:${moveBps >= 0 ? "up" : "down"}` }];
    });
  }
}

export interface PortfolioEvidenceInput { snapshot: PortfolioSnapshot; impact: RiskImpact | null; reliable: boolean; limitations: string[]; }

export async function buildDeterministicCloseReview(command: MarketAgentCommand, snapshot: MarketSnapshot, events: MarketEvent[], runId: string, watchlistRevision = "unconfigured", portfolio?: PortfolioEvidenceInput): Promise<SealedEvidenceBundle> {
  const items: EvidenceItem[] = snapshot.data.quotes.map((quote, index) => ({ id: `${runId}:quote:${index}`, kind: "market_fact", origin: "server-observed", value: { type: "quote", ...quote }, reliable: quote.quality === "live" && !quote.stale }));
  snapshot.data.bars.forEach((series, index) => items.push({ id: `${runId}:bars:${index}`, kind: "market_fact", origin: "server-observed", value: { type: "bar_series", ...series }, reliable: series.bars.length > 0 }));
  snapshot.data.news.forEach((news, index) => items.push({ id: `${runId}:news:${index}`, kind: "market_fact", origin: "server-observed", value: { evidenceType: "news", ...news }, reliable: Boolean(news.publishedAt) && news.warnings.length === 0 }));
  snapshot.data.announcements.forEach((announcement, index) => items.push({ id: `${runId}:announcement:${index}`, kind: "market_fact", origin: "server-observed", value: { evidenceType: "announcement", ...announcement }, reliable: Boolean(announcement.publishedAt) && announcement.warnings.length === 0 }));
  snapshot.data.status.forEach((status, index) => items.push({ id: `${runId}:status:${index}`, kind: "market_fact", origin: "server-observed", value: { type: "market_status", ...status }, reliable: status.reliable }));
  for (const capability of snapshot.capabilities.filter((item) => item.status !== "operational")) items.push({ id: `${runId}:limitation:${items.length}`, kind: "limitation", origin: "server-observed", value: { capability: capability.id, status: capability.status, warnings: capability.warnings }, reliable: true });
  if (!snapshot.quality.reliable || snapshot.quality.warnings.length) items.push({ id: `${runId}:limitation:quality`, kind: "limitation", origin: "server-observed", value: { quality: snapshot.quality.status, freshness: snapshot.quality.freshness, warnings: snapshot.quality.warnings, unavailableCapabilities: snapshot.quality.unavailableCapabilities }, reliable: true });
  if (portfolio) {
    if (portfolio.reliable) {
      const snapshotEvidenceId = `${runId}:portfolio:snapshot`;
      items.push({
        id: snapshotEvidenceId,
        kind: "portfolio_impact",
        origin: "user-supplied-risk-snapshot",
        value: {
          type: "portfolio_snapshot",
          id: portfolio.snapshot.id,
          schemaVersion: portfolio.snapshot.schemaVersion,
          sourceRevision: portfolio.snapshot.sourceRevision,
          calculatedAt: portfolio.snapshot.calculatedAt,
          effectiveAt: portfolio.snapshot.effectiveAt,
          expiresAt: portfolio.snapshot.expiresAt,
          positions: portfolio.snapshot.positions,
          cash: portfolio.snapshot.cash,
          rulesVersion: portfolio.snapshot.rulesVersion,
          warnings: portfolio.snapshot.warnings,
          fingerprint: portfolio.snapshot.fingerprint,
        },
        reliable: true,
      });
      if (portfolio.impact) items.push({ id: `${runId}:portfolio:risk-impact`, kind: "portfolio_impact", origin: "server-observed", value: { type: "risk_impact", snapshotId: portfolio.snapshot.id, impact: portfolio.impact }, reliable: true });
    }
    for (const limitation of portfolio.limitations) items.push({ id: `${runId}:portfolio:limitation:${items.length}`, kind: "limitation", origin: "server-observed", value: { type: "portfolio_snapshot", snapshotId: portfolio.snapshot.id, limitation }, reliable: true });
  }
  for (const event of events) items.push({ id: event.evidenceId, kind: "market_event", origin: "server-observed", value: event, reliable: event.reliable });
  const commandForFingerprint = isMarketAgentAskCommand(command)
    ? { workflow: command.workflow, profileId: command.profileId, scope: command.scope, instrumentId: command.instrumentId ?? null, priorRunId: command.priorRunId ?? null, resolvedInstrumentIds: command.resolvedInstrumentIds }
    : { workflow: command.workflow, profileId: command.profileId, instrumentId: command.instrumentId ?? null, marketDate: command.marketDate ?? null };
  const canonical = stableFingerprint({ command: commandForFingerprint, snapshot, events, watchlistRevision, portfolio: portfolio ? portfolio.reliable ? { snapshot: portfolio.snapshot, impact: portfolio.impact, limitations: portfolio.limitations } : { snapshotId: portfolio.snapshot.id, reliable: false, limitations: portfolio.limitations } : null });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return { schemaVersion: MARKET_AGENT_SCHEMA_VERSION, eventRuleVersion: EVENT_RULE_VERSION, profileId: command.profileId, workflow: command.workflow, watchlistRevision, instrumentIds: snapshot.request.instrumentIds, items, contextUses: [], fingerprint: `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`, sealedAt: new Date().toISOString() };
}

export async function buildDeterministicAskEvidence(input: {
  command: MarketAgentAskCommand;
  snapshot: MarketSnapshot;
  events: MarketEvent[];
  runId: string;
  watchlistRevision: string;
  plan: AskEvidencePlan;
  portfolio?: PortfolioEvidenceInput;
  previous?: { runId: string; workflow: string; createdAt: string; evidenceFingerprint: string; result: AgentResult };
}): Promise<SealedEvidenceBundle> {
  const base = await buildDeterministicCloseReview(
    input.command,
    input.snapshot,
    input.events,
    input.runId,
    input.watchlistRevision,
    input.portfolio,
  );
  const items: EvidenceItem[] = [
    ...base.items,
    {
      id: `${input.runId}:ask:plan`,
      kind: "execution_plan",
      origin: "server-observed",
      value: {
        type: "ask_plan",
        version: "ask-plan.v1",
        scope: input.command.scope,
        intervals: input.plan.intervals,
        include: input.plan.include,
        quoteMode: input.plan.quoteMode,
      },
      reliable: true,
    },
  ];
  if (input.previous) {
    items.push({
      id: `${input.runId}:ask:previous-run`,
      kind: "prior_run",
      origin: "server-observed",
      value: {
        type: "previous_run",
        runId: input.previous.runId,
        workflow: input.previous.workflow,
        createdAt: input.previous.createdAt,
        evidenceFingerprint: input.previous.evidenceFingerprint,
        result: input.previous.result,
      },
      reliable: true,
    });
  }
  const canonical = stableFingerprint({
    baseFingerprint: base.fingerprint,
    ask: {
      scope: input.command.scope,
      planVersion: "ask-plan.v1",
      priorRunId: input.command.priorRunId ?? null,
      previous: input.previous ? {
        runId: input.previous.runId,
        evidenceFingerprint: input.previous.evidenceFingerprint,
        result: input.previous.result,
      } : null,
    },
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return {
    ...base,
    items,
    ask: {
      scope: input.command.scope,
      planVersion: "ask-plan.v1",
      ...(input.command.priorRunId ? { priorRunId: input.command.priorRunId } : {}),
    },
    fingerprint: `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
}

export class MemoryRunRepository {
  private readonly runs = new Map<string, AgentRun>();
  async createQueued(command: MarketAgentCommand, request: RunCreation): Promise<{ run: AgentRun; created: boolean }> {
    const existing = [...this.runs.values()].find((run) => run.profileId === command.profileId && run.idempotencyKey === command.idempotencyKey);
    if (existing) { if (existing.commandHash !== request.commandHash) throw new Error("IDEMPOTENCY_KEY_REUSED"); return { run: existing, created: false }; }
    const now = new Date().toISOString();
    const run: AgentRun = { id: crypto.randomUUID(), profileId: command.profileId, workflow: command.workflow, trigger: command.trigger, status: "queued", idempotencyKey: command.idempotencyKey, commandHash: request.commandHash, revisionOfRunId: request.revisionOfRunId ?? null, portfolioSnapshotId: request.portfolioSnapshotId ?? null, attempt: 0, recoveryGeneration: 0, createdAt: now, updatedAt: now, evidenceFingerprint: null, failure: null };
    this.runs.set(run.id, run); return { run, created: true };
  }
  async get(runId: string) { return this.runs.get(runId) ?? null; }
  async findByIdempotencyKey(key: string) { return [...this.runs.values()].find((run) => run.idempotencyKey === key) ?? null; }
  async claim(runId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<RunClaimResult> {
    const run = this.runs.get(runId); if (!run) return { kind: "missing" }; const leased = run as AgentRun & { leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string }; if (["success", "partial", "failed"].includes(run.status)) return { kind: "terminal" }; if (leased.leaseExpiresAt && leased.leaseExpiresAt > now) return { kind: "leased", retryAfter: leased.leaseExpiresAt };
    const leaseToken = crypto.randomUUID(); run.status = "collecting"; run.attempt += 1; run.updatedAt = now; (run as AgentRun & { leaseOwner: string; leaseToken: string; leaseExpiresAt: string }).leaseOwner = workerId; (run as AgentRun & { leaseToken: string; leaseExpiresAt: string }).leaseToken = leaseToken; (run as AgentRun & { leaseExpiresAt: string }).leaseExpiresAt = leaseExpiresAt;
    return { kind: "claimed", lease: { run, leaseToken, attempt: run.attempt, leaseExpiresAt } };
  }
}

function stableFingerprint(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableFingerprint((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }
