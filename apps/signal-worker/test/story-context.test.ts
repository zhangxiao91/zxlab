import { describe, expect, it } from "vitest";
import type { CandidateSignal } from "@zxlab/signal-schema";
import { buildStoryDossiers, storySimilarity } from "../src/services/story-context";
import { selectSynthesisCandidates } from "../src/services/briefing-generator";

function candidate(id: string, title: string, publishedAt = "2026-07-25T00:00:00.000Z"): CandidateSignal {
  return {
    id,
    source: { sourceId: `source-${id}`, sourceName: `Publisher ${id}`, sourceType: "rss", externalId: id },
    categoryHint: "ai-engineering",
    title,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    summary: `Summary for ${title}`,
    publishedAt,
    fetchedAt: publishedAt,
    tags: ["news"],
    contentHash: id,
    metadata: {},
    collectionRunId: "story-context-test",
    status: "eligible",
  };
}

describe("Signal story context", () => {
  it("clusters independent reports about one event without grouping a routine vendor update", () => {
    const reports = [
      candidate("report-a", "OpenAI agrees major cloud infrastructure deal with Oracle"),
      candidate("report-b", "Oracle and OpenAI sign major cloud infrastructure agreement"),
      candidate("unrelated", "OpenAI Node SDK adds response helper"),
    ];
    const dossiers = buildStoryDossiers(reports);
    expect(dossiers).toHaveLength(2);
    expect(dossiers.find((dossier) => dossier.currentCandidateIds.includes("report-a"))?.currentCandidateIds)
      .toEqual(["report-a", "report-b"]);
    expect(storySimilarity(reports[0]!.title, reports[2]!.title)).toBe(0);
  });

  it("attaches matching historical signals and prior coverage but excludes unrelated context", () => {
    const current = [candidate("current", "Anthropic expands Claude enterprise agreement with major banks")];
    const historical = [
      candidate("history-match", "Major banks begin Anthropic Claude enterprise agreement", "2026-07-10T00:00:00.000Z"),
      candidate("history-other", "Google releases a small open model", "2026-07-12T00:00:00.000Z"),
    ];
    const dossiers = buildStoryDossiers(current, historical, [
      { briefingDate: "2026-07-11", title: "Anthropic Claude enterprise agreement reaches major banks", summary: "Earlier coverage." },
      { briefingDate: "2026-07-12", title: "Copper inventories fall", summary: "Unrelated coverage." },
    ]);
    expect(dossiers[0]?.historicalSignals.map((item) => item.candidateId)).toEqual(["history-match"]);
    expect(dossiers[0]?.priorCoverage.map((item) => item.briefingDate)).toEqual(["2026-07-11"]);
  });

  it("retains merged reports as supporting synthesis evidence", () => {
    const candidates = [candidate("primary", "OpenAI signs Oracle cloud agreement"), candidate("supporting", "Oracle confirms OpenAI cloud agreement")];
    const selected = selectSynthesisCandidates(candidates, [
      { candidateId: "primary", decision: "keep", category: "ai-engineering", relevance: 90, novelty: 90, actionability: 50, sourceQuality: 90, reason: "Primary report", relatedMemoryIds: [] },
      { candidateId: "supporting", decision: "merge", mergeTargetCandidateId: "primary", category: "ai-engineering", relevance: 85, novelty: 80, actionability: 40, sourceQuality: 88, reason: "Independent confirmation", relatedMemoryIds: [] },
    ]);
    expect(selected.map((item) => item.id)).toEqual(["primary", "supporting"]);
  });

  it("does not re-add dropped candidates merely to reach ten items", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(`daily-${index + 1}`, `Daily candidate ${index + 1}`));
    const decisions = candidates.map((item, index) => ({
      candidateId: item.id,
      decision: index < 9 ? "keep" as const : "drop" as const,
      category: "ai-engineering" as const,
      relevance: index === 11 ? 95 : 50,
      novelty: index === 11 ? 95 : 50,
      actionability: 50,
      sourceQuality: index === 11 ? 95 : 50,
      reason: "Editorial test decision",
      relatedMemoryIds: [],
    }));
    const selected = selectSynthesisCandidates(candidates, decisions);
    expect(selected).toHaveLength(9);
    expect(selected.map((item) => item.id)).toEqual(candidates.slice(0, 9).map((item) => item.id));
  });
});
