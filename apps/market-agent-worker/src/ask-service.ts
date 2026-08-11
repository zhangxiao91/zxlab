import type {
  AgentResult,
  MarketAgentAskCommand,
  PortfolioSnapshot,
  SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { askEvidencePlan } from "./ask-plan.ts";
import type { CurrentMarketSnapshotReader } from "./close-review.ts";
import {
  buildDeterministicAskEvidence,
  DeterministicMarketEventDetector,
} from "./foundation.ts";
import { narrateWithRepair, type Narrator, DeterministicNarrator } from "./narration.ts";
import { evaluatePortfolioRiskImpact } from "./portfolio-risk-impact.ts";
import type { ConfirmedContextReader } from "./confirmed-context.ts";

export interface AskPreviousRun {
  runId: string;
  workflow: string;
  createdAt: string;
  evidenceFingerprint: string;
  result: AgentResult;
}

export interface AskServiceInput {
  runId: string;
  command: MarketAgentAskCommand;
  watchlistRevision: string;
  portfolioSnapshot?: PortfolioSnapshot | null;
  previous?: AskPreviousRun;
}

export class AskService {
  private readonly reader: CurrentMarketSnapshotReader;
  private readonly narrator: Narrator;
  private readonly contextReader?: ConfirmedContextReader;

  constructor(reader: CurrentMarketSnapshotReader, narrator: Narrator = new DeterministicNarrator(), contextReader?: ConfirmedContextReader) {
    this.reader = reader;
    this.narrator = narrator;
    this.contextReader = contextReader;
  }

  async execute(input: AskServiceInput): Promise<{
    evidence: SealedEvidenceBundle;
    result: AgentResult;
    repaired: boolean;
  }> {
    const plan = askEvidencePlan(input.command.scope);
    if (!input.command.resolvedInstrumentIds.length) throw new Error("ASK_SCOPE_EMPTY");
    if (plan.requiresPortfolioSnapshot && !input.portfolioSnapshot) throw new Error("ASK_PORTFOLIO_SNAPSHOT_MISSING");
    if (plan.requiresPreviousRun && !input.previous) throw new Error("ASK_PREVIOUS_RUN_MISSING");

    const snapshot = await this.reader.getCurrentSnapshot({
      instrumentIds: input.command.resolvedInstrumentIds,
      intervals: plan.intervals,
      include: plan.include,
      quoteMode: plan.quoteMode,
    });
    assertFixedSnapshotScope(snapshot, input.command, plan);

    const events = new DeterministicMarketEventDetector().detect({
      runId: input.runId,
      current: snapshot,
    });
    const portfolio = input.portfolioSnapshot
      ? evaluatePortfolioRiskImpact(scopedPortfolio(input.portfolioSnapshot, input.command.resolvedInstrumentIds), snapshot)
      : undefined;
    const confirmedContext = this.contextReader
      ? await this.contextReader.retrieve({ profileId: input.command.profileId, workflow: "ask", instrumentIds: input.command.resolvedInstrumentIds, question: input.command.question })
      : { contexts: [], limitations: [] };
    const evidence = await buildDeterministicAskEvidence({
      command: input.command,
      snapshot,
      events,
      runId: input.runId,
      watchlistRevision: input.watchlistRevision,
      plan,
      portfolio,
      previous: input.previous,
      confirmedContext,
    });
    const narration = await narrateWithRepair(this.narrator, {
      workflow: "ask",
      evidence,
      askScope: input.command.scope,
      question: input.command.question,
      confirmedContext: confirmedContext.contexts,
    });
    return {
      evidence,
      repaired: narration.repaired,
      result: {
        ...narration.result,
        mode: portfolio?.reliable ? "portfolio-aware" : "market-only",
        askScope: input.command.scope,
      },
    };
  }
}

function assertFixedSnapshotScope(
  snapshot: MarketSnapshot,
  command: MarketAgentAskCommand,
  plan: ReturnType<typeof askEvidencePlan>,
): void {
  if (
    !sameValues(snapshot.request.instrumentIds, command.resolvedInstrumentIds)
    || !sameValues(snapshot.request.intervals, plan.intervals)
    || !sameValues(snapshot.request.include, plan.include)
    || snapshot.request.quoteMode !== plan.quoteMode
  ) {
    throw new Error("ASK_SNAPSHOT_SCOPE_MISMATCH");
  }
}

function scopedPortfolio(snapshot: PortfolioSnapshot, instrumentIds: string[]): PortfolioSnapshot {
  const allowed = new Set(instrumentIds);
  return {
    ...snapshot,
    positions: snapshot.positions.filter((position) => allowed.has(position.instrumentId)),
  };
}

function sameValues(values: readonly string[], expected: readonly string[]): boolean {
  if (values.length !== expected.length) return false;
  return [...values].sort().every((value, index) => value === [...expected].sort()[index]);
}
