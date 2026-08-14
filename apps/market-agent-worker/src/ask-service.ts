import type {
  AgentResult,
  ConfirmedContext,
  MarketAgentAskCommand,
  PortfolioSnapshot,
  RunStatus,
  SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { askEvidencePlan } from "./ask-plan.ts";
import type { CurrentMarketSnapshotReader, EvidenceCheckpoint } from "./close-review.ts";
import {
  buildDeterministicAskEvidence,
  DeterministicMarketEventDetector,
} from "./foundation.ts";
import { narrateWithRepair, type Narrator, DeterministicNarrator } from "./narration.ts";
import { evaluatePortfolioRiskImpact } from "./portfolio-risk-impact.ts";
import type { ConfirmedContextReader } from "./confirmed-context.ts";
import { assessEvidence } from "./evidence-assessment.ts";
import { finalizeAgentResult } from "./run-outcome.ts";
import { createRunCheckpoint, verifyRunCheckpoint } from "./run-checkpoint.ts";

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
  previousSnapshot?: MarketSnapshot;
  checkpoint?: EvidenceCheckpoint;
  onCheckpoint?: (checkpoint: EvidenceCheckpoint) => Promise<void> | void;
  onProgress?: (status: Extract<RunStatus, "evidence_sealed" | "generating" | "validating">) => Promise<void> | void;
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
    if (!input.checkpoint && plan.requiresPortfolioSnapshot && !input.portfolioSnapshot) throw new Error("ASK_PORTFOLIO_SNAPSHOT_MISSING");
    if (!input.checkpoint && plan.requiresPreviousRun && !input.previous) throw new Error("ASK_PREVIOUS_RUN_MISSING");

    const snapshot = input.checkpoint?.snapshot ?? await this.reader.getCurrentSnapshot({
      instrumentIds: input.command.resolvedInstrumentIds,
      intervals: plan.intervals,
      include: plan.include,
      quoteMode: plan.quoteMode,
    });
    assertFixedSnapshotScope(snapshot, input.command, plan);

    const confirmedContext = !input.checkpoint && this.contextReader
      ? await this.contextReader.retrieve({ profileId: input.command.profileId, workflow: "ask", instrumentIds: input.command.resolvedInstrumentIds, question: input.command.question })
      : { contexts: [], limitations: [] };
    const portfolio = !input.checkpoint && input.portfolioSnapshot
      ? evaluatePortfolioRiskImpact(scopedPortfolio(input.portfolioSnapshot, input.command.resolvedInstrumentIds), snapshot)
      : undefined;
    const evidence = input.checkpoint?.evidence ?? await buildDeterministicAskEvidence({
        command: input.command,
        snapshot,
        events: new DeterministicMarketEventDetector().detect({ runId: input.runId, current: snapshot }),
        runId: input.runId,
        watchlistRevision: input.watchlistRevision,
        plan,
        portfolio,
        previous: input.previous,
        previousSnapshot: input.previousSnapshot,
        confirmedContext,
      });
    if (input.checkpoint && (!await verifyRunCheckpoint(input.checkpoint) || evidence.profileId !== input.command.profileId || evidence.workflow !== "ask" || evidence.ask?.scope !== input.command.scope || evidence.ask.planVersion !== "ask-plan.v1" || evidence.ask.priorRunId !== input.command.priorRunId || !sameValues(evidence.instrumentIds, input.command.resolvedInstrumentIds))) throw new Error("RUN_CHECKPOINT_SCOPE_MISMATCH");
    if (!input.checkpoint && input.onCheckpoint) await input.onCheckpoint(await createRunCheckpoint(snapshot, evidence));
    else await input.onProgress?.("evidence_sealed");
    await input.onProgress?.("generating");
    const narration = await narrateWithRepair(this.narrator, {
      workflow: "ask",
      evidence,
      askScope: input.command.scope,
      question: input.command.question,
      confirmedContext: matchingConfirmedContext(confirmedContext.contexts, evidence),
    });
    await input.onProgress?.("validating");
    const mode = input.checkpoint ? hasReliablePortfolioImpact(evidence) ? "portfolio-aware" : "market-only" : portfolio?.reliable ? "portfolio-aware" : "market-only";
    return {
      evidence,
      repaired: narration.repaired,
      result: finalizeAgentResult({
        narration: narration.result,
        provenance: narration.provenance,
        evidence: assessEvidence(input.command.scope, snapshot, mode === "portfolio-aware"),
        mode,
        askScope: input.command.scope,
      }),
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

function matchingConfirmedContext(contexts: ConfirmedContext[], evidence: SealedEvidenceBundle): ConfirmedContext[] {
  const allowed = new Set(evidence.contextUses.map((item) => `${item.memoryId}:${item.revisionHash}`));
  return contexts.filter((item) => allowed.has(`${item.memoryId}:${item.revisionHash}`));
}

function hasReliablePortfolioImpact(evidence: SealedEvidenceBundle): boolean {
  return evidence.items.some((item) => {
    const value = item.value as { type?: unknown } | null;
    return item.kind === "portfolio_impact" && item.reliable && value?.type === "risk_impact";
  });
}
