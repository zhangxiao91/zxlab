import type { AgentResult, MarketAgentCommand, PortfolioSnapshot, RunStatus, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { DeterministicMarketEventDetector, buildDeterministicCloseReview } from "./foundation.ts";
import { DeterministicNarrator, narrateWithRepair, type Narrator } from "./narration.ts";
import { evaluatePortfolioRiskImpact } from "./portfolio-risk-impact.ts";
import type { ConfirmedContextReader } from "./confirmed-context.ts";

export interface CurrentMarketSnapshotReader { getCurrentSnapshot(input: { instrumentIds: string[]; intervals: Array<"1m" | "1d">; include: Array<"quotes" | "bars" | "news" | "announcements" | "comparisons">; quoteMode: "fallback" | "corroborated" }): Promise<MarketSnapshot>; }

export class CloseReviewService {
  private readonly reader: CurrentMarketSnapshotReader;
  private readonly narrator: Narrator;
  private readonly contextReader?: ConfirmedContextReader;
  constructor(reader: CurrentMarketSnapshotReader, narrator: Narrator = new DeterministicNarrator(), contextReader?: ConfirmedContextReader) { this.reader = reader; this.narrator = narrator; this.contextReader = contextReader; }

  async execute(input: { runId: string; command: MarketAgentCommand; instrumentIds: string[]; watchlistRevision: string; portfolioSnapshot?: PortfolioSnapshot | null; previous?: MarketSnapshot; onProgress?: (status: Extract<RunStatus, "evidence_sealed" | "generating" | "validating">) => Promise<void> | void }): Promise<{ evidence: SealedEvidenceBundle; result: AgentResult; repaired: boolean }> {
    const snapshot = await this.reader.getCurrentSnapshot({ instrumentIds: input.instrumentIds, intervals: ["1d"], include: ["quotes", "bars", "news", "announcements"], quoteMode: "corroborated" });
    const events = new DeterministicMarketEventDetector().detect({ runId: input.runId, current: snapshot, previous: input.previous });
    const portfolio = input.portfolioSnapshot ? evaluatePortfolioRiskImpact(input.portfolioSnapshot, snapshot) : undefined;
    const confirmedContext = this.contextReader
      ? await this.contextReader.retrieve({ profileId: input.command.profileId, workflow: input.command.workflow, instrumentIds: input.instrumentIds, question: input.command.question })
      : { contexts: [], limitations: [] };
    const evidence = await buildDeterministicCloseReview(input.command, snapshot, events, input.runId, input.watchlistRevision, portfolio, confirmedContext);
    await input.onProgress?.("evidence_sealed");
    await input.onProgress?.("generating");
    const narration = await narrateWithRepair(this.narrator, { workflow: input.command.workflow, evidence, confirmedContext: confirmedContext.contexts });
    await input.onProgress?.("validating");
    return { evidence, repaired: narration.repaired, result: { ...narration.result, mode: portfolio?.reliable ? "portfolio-aware" : "market-only" } };
  }
}
