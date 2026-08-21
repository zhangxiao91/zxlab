import { validateSealedEvidence, type AgentResult, type ConfirmedContext, type MarketAgentCommand, type PortfolioSnapshot, type RunStatus, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import type { ResearchFactBundle } from "@zxlab/research-fact-schema";
import { DeterministicMarketEventDetector, buildDeterministicCloseReview, sealedResearchOmittedInstrumentCount } from "./foundation.ts";
import { DeterministicNarrator, narrateWithRepair, type Narrator } from "./narration.ts";
import { evaluatePortfolioRiskImpact } from "./portfolio-risk-impact.ts";
import type { ConfirmedContextReader } from "./confirmed-context.ts";
import { assessEvidence } from "./evidence-assessment.ts";
import { finalizeAgentResult } from "./run-outcome.ts";
import { createRunCheckpoint, verifyRunCheckpoint, type RunCheckpoint } from "./run-checkpoint.ts";
import { assertResearchFactScope, researchExpectedLatestSessionDate, selectResearchInstrumentScope, type ResearchFactReader } from "./research-fact-reader.ts";

export interface CurrentMarketSnapshotReader { getCurrentSnapshot(input: { instrumentIds: string[]; intervals: Array<"1m" | "1d">; include: Array<"quotes" | "bars" | "news" | "announcements" | "comparisons">; quoteMode: "fallback" | "corroborated" }): Promise<MarketSnapshot>; }
export type EvidenceCheckpoint = RunCheckpoint;

export class CloseReviewService {
  private readonly reader: CurrentMarketSnapshotReader;
  private readonly narrator: Narrator;
  private readonly contextReader?: ConfirmedContextReader;
  private readonly researchReader?: ResearchFactReader;
  constructor(reader: CurrentMarketSnapshotReader, narrator: Narrator = new DeterministicNarrator(), contextReader?: ConfirmedContextReader, researchReader?: ResearchFactReader) { this.reader = reader; this.narrator = narrator; this.contextReader = contextReader; this.researchReader = researchReader; }

  async execute(input: { runId: string; command: MarketAgentCommand; instrumentIds: string[]; watchlistRevision: string; portfolioSnapshot?: PortfolioSnapshot | null; previous?: MarketSnapshot; checkpoint?: EvidenceCheckpoint; onCheckpoint?: (checkpoint: EvidenceCheckpoint) => Promise<void> | void; onProgress?: (status: Extract<RunStatus, "evidence_sealed" | "generating" | "validating">) => Promise<void> | void }): Promise<{ evidence: SealedEvidenceBundle; result: AgentResult; repaired: boolean }> {
    const confirmedContext = !input.checkpoint && this.contextReader
      ? await this.contextReader.retrieve({ profileId: input.command.profileId, workflow: input.command.workflow, instrumentIds: input.instrumentIds, question: input.command.question })
      : { contexts: [], limitations: [] };
    const snapshot = input.checkpoint?.snapshot ?? await this.reader.getCurrentSnapshot({ instrumentIds: input.instrumentIds, intervals: ["1d"], include: ["quotes", "bars", "news", "announcements"], quoteMode: "corroborated" });
    const expectedLatestSessionDate = researchExpectedLatestSessionDate(snapshot);
    const researchScope = selectResearchInstrumentScope(input.instrumentIds, input.command.instrumentId);
    let research: ResearchFactBundle | undefined;
    if (input.checkpoint) research = input.checkpoint.research;
    else if (input.command.workflow === "close_review" && this.researchReader) {
      research = await this.researchReader.materialize({
        purpose: "price_context",
        instrumentIds: researchScope.instrumentIds,
        ...(input.command.instrumentId ? { selectedInstrumentId: input.command.instrumentId } : {}),
        observationCutoff: snapshot.asOf,
        ...(expectedLatestSessionDate ? { expectedLatestSessionDate } : {}),
      });
    }
    if (research) await assertResearchFactScope({ research, purpose: "price_context", instrumentIds: researchScope.instrumentIds, observationCutoff: snapshot.asOf, expectedLatestSessionDate, allowLegacyExpectedSession: Boolean(input.checkpoint) });
    let evidence: SealedEvidenceBundle;
    let portfolioAware: boolean;
    if (input.checkpoint) {
      if (!await verifyRunCheckpoint(input.checkpoint)) throw new Error("RUN_CHECKPOINT_INTEGRITY_MISMATCH");
      assertCheckpointScope(input.checkpoint, input.command, input.instrumentIds);
      evidence = input.checkpoint.evidence;
      portfolioAware = hasReliablePortfolioImpact(evidence);
    } else {
      const events = new DeterministicMarketEventDetector().detect({ runId: input.runId, current: snapshot, previous: input.previous });
      const portfolio = input.portfolioSnapshot ? evaluatePortfolioRiskImpact(input.portfolioSnapshot, snapshot) : undefined;
      evidence = await buildDeterministicCloseReview(input.command, snapshot, events, input.runId, input.watchlistRevision, portfolio, confirmedContext, input.previous, research, input.command.workflow === "close_review" ? researchScope.omittedInstrumentIds : []);
      portfolioAware = Boolean(portfolio?.reliable);
    }
    const checkpoint = await createRunCheckpoint(snapshot, evidence, research);
    if (!input.checkpoint && input.onCheckpoint) await input.onCheckpoint(checkpoint);
    else await input.onProgress?.("evidence_sealed");
    const mode = portfolioAware ? "portfolio-aware" : "market-only";
    const researchOmittedInstrumentCount = input.checkpoint
      ? sealedResearchOmittedInstrumentCount(evidence)
      : input.command.workflow === "close_review" ? researchScope.omittedInstrumentIds.length : 0;
    const evidenceAssessment = assessEvidence(input.command.workflow, snapshot, mode === "portfolio-aware", research, researchOmittedInstrumentCount);
    await input.onProgress?.("generating");
    const narration = await narrateWithRepair(this.narrator, { workflow: input.command.workflow, evidence, evidenceAssessment, confirmedContext: matchingConfirmedContext(confirmedContext.contexts, evidence) });
    await input.onProgress?.("validating");
    return {
      evidence,
      repaired: narration.repaired,
      result: finalizeAgentResult({
        narration: narration.result,
        provenance: narration.provenance,
        evidence: evidenceAssessment,
        sealedEvidence: evidence,
        mode,
      }),
    };
  }
}

function assertCheckpointScope(checkpoint: EvidenceCheckpoint, command: MarketAgentCommand, instrumentIds: string[]): void {
  const issues = validateSealedEvidence(checkpoint.evidence);
  if (
    issues.length
    || checkpoint.evidence.profileId !== command.profileId
    || checkpoint.evidence.workflow !== command.workflow
    || !sameValues(checkpoint.evidence.instrumentIds, instrumentIds)
    || !sameValues(checkpoint.snapshot.request.instrumentIds, instrumentIds)
  ) throw new Error("RUN_CHECKPOINT_SCOPE_MISMATCH");
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

function sameValues(values: readonly string[], expected: readonly string[]): boolean {
  if (values.length !== expected.length) return false;
  const sorted = [...expected].sort();
  return [...values].sort().every((value, index) => value === sorted[index]);
}
