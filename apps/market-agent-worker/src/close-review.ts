import type { AgentResult, MarketAgentCommand, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { DeterministicMarketEventDetector, buildDeterministicCloseReview } from "./foundation.ts";
import { DeterministicNarrator, narrateWithRepair, type Narrator } from "./narration.ts";

export interface CurrentMarketSnapshotReader { getCurrentSnapshot(input: { instrumentIds: string[]; intervals: Array<"1m" | "1d">; include: Array<"quotes" | "bars" | "news" | "announcements" | "comparisons">; quoteMode: "fallback" | "corroborated" }): Promise<MarketSnapshot>; }

export class CloseReviewService {
  private readonly reader: CurrentMarketSnapshotReader;
  private readonly narrator: Narrator;
  constructor(reader: CurrentMarketSnapshotReader, narrator: Narrator = new DeterministicNarrator()) { this.reader = reader; this.narrator = narrator; }

  async execute(input: { runId: string; command: MarketAgentCommand; instrumentIds: string[]; watchlistRevision: string; previous?: MarketSnapshot }): Promise<{ evidence: SealedEvidenceBundle; result: AgentResult; repaired: boolean }> {
    const snapshot = await this.reader.getCurrentSnapshot({ instrumentIds: input.instrumentIds, intervals: ["1d"], include: ["quotes", "bars", "news", "announcements"], quoteMode: "corroborated" });
    const events = new DeterministicMarketEventDetector().detect({ runId: input.runId, current: snapshot, previous: input.previous });
    const evidence = await buildDeterministicCloseReview(input.command, snapshot, events, input.runId, input.watchlistRevision);
    const narration = await narrateWithRepair(this.narrator, { workflow: "close_review", evidence });
    return { evidence, repaired: narration.repaired, result: { ...narration.result, mode: "market-only" } };
  }
}
