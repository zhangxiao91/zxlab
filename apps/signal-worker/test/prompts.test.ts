import { describe, expect, it } from "vitest";
import type { CandidateSignal } from "@zxlab/signal-schema";
import { buildBriefingPrompt, buildEditorialPrompt } from "../src/services/prompts";

function candidate(id: string): CandidateSignal {
  return {
    id,
    source: { sourceId: "source", sourceName: "Source", sourceType: "rss", externalId: id },
    categoryHint: "ai-engineering",
    title: `Candidate ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    summary: "s".repeat(5_000),
    contentText: "c".repeat(12_000),
    fetchedAt: "2026-07-25T00:00:00.000Z",
    tags: ["test"],
    contentHash: id,
    metadata: { oversized: "m".repeat(5_000) },
    collectionRunId: "test",
    status: "eligible",
  };
}

describe("Signal prompts", () => {
  it("bounds candidate context for both editorial and briefing requests", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(String(index)));
    for (const prompt of [buildEditorialPrompt({ candidates, memories: [] }), buildBriefingPrompt({ date: "2026-07-25", candidates, memories: [] })]) {
      const payload = JSON.parse(prompt.user) as { candidates: Array<{ summary?: string; contentText?: string; metadata?: unknown }> };
      expect(payload.candidates).toHaveLength(12);
      expect(payload.candidates[0]?.summary).toHaveLength(600);
      expect(payload.candidates[0]?.contentText).toHaveLength(600);
      expect(payload.candidates[0]).not.toHaveProperty("metadata");
      expect(prompt.user.length).toBeLessThan(25_000);
    }
  });

  it("keeps project memory subordinate to the news agenda", () => {
    const prompt = buildBriefingPrompt({
      date: "2026-07-25",
      candidates: [candidate("workers")],
      memories: [{
        id: "workers-memory",
        scope: "project",
        scopeKey: "zxlab",
        content: "zxlab 的新后端能力应优先兼容 Cloudflare Workers 运行时。",
        confidence: 0.9,
        status: "active",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastConfirmedAt: "2026-07-01T00:00:00.000Z",
      }],
    });
    expect(prompt.system).toContain("Write as a news editor");
    expect(prompt.system).toContain("must not determine the news agenda");
    expect(prompt.system).not.toContain("Node.js API dependencies");
    expect(prompt.system).not.toContain("persistent-process assumptions");
  });

  it("sets explicit editorial limits for release notes and vendor concentration", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(`release-${index}`));
    const briefing = buildBriefingPrompt({ date: "2026-07-25", candidates, memories: [] });
    const editorial = buildEditorialPrompt({ candidates, memories: [] });
    expect(briefing.system).toContain("never more than one third of the briefing");
    expect(briefing.system).toContain("Return 10 to 12 items");
    expect(editorial.system).toContain("no more than one third of keep decisions");
    expect(editorial.system).toContain("support a 10-12 item briefing");
    expect(editorial.system).toContain("public significance");
  });

  it("penalizes launch hype and keeps infrastructure radar subordinate", () => {
    const editorial = buildEditorialPrompt({ candidates: [candidate("product")], memories: [] });
    const briefing = buildBriefingPrompt({ date: "2026-08-21", candidates: [candidate("product")], memories: [] });

    for (const prompt of [editorial.system, briefing.system]) {
      expect(prompt).toContain("Product Hunt");
      expect(prompt).toContain("launch hype");
      expect(prompt).toContain("Cloudflare");
      expect(prompt).toContain("breaking change");
      expect(prompt).toContain("pricing");
      expect(prompt).toContain("quota");
    }
  });

  it("reduces the requested item range when candidates collapse into fewer independent dossiers", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(`story-${index}`));
    const storyDossiers = [
      {
        id: "clustered-story",
        anchorCandidateId: "story-0",
        currentCandidateIds: ["story-0", "story-1", "story-2", "story-3", "story-4"],
        historicalSignals: [],
        priorCoverage: [],
      },
      ...candidates.slice(5).map((value) => ({
        id: `dossier-${value.id}`,
        anchorCandidateId: value.id,
        currentCandidateIds: [value.id],
        historicalSignals: [],
        priorCoverage: [],
      })),
    ];

    const briefing = buildBriefingPrompt({ date: "2026-08-10", candidates, memories: [], storyDossiers });
    const editorial = buildEditorialPrompt({ candidates, memories: [], storyDossiers });

    expect(briefing.system).toContain("Return 1 to 8 items");
    expect(briefing.system).toContain("Never split one storyDossier across multiple items");
    expect(briefing.system).toContain("never pad the edition to ten with duplicate stories");
    expect(editorial.system).toContain("support a 1-8 item briefing");
  });

  it("supplies bounded story history to both editorial stages", () => {
    const storyDossiers = [{
      id: "story-1",
      anchorCandidateId: "current",
      currentCandidateIds: ["current", "supporting"],
      historicalSignals: [{
        candidateId: "history",
        title: "Earlier event",
        summary: "h".repeat(2_000),
        sourceName: "Historical Source",
        publishedAt: "2026-07-01T00:00:00.000Z",
      }],
      priorCoverage: [{ briefingDate: "2026-07-02", title: "Earlier briefing", summary: "p".repeat(2_000) }],
    }];
    for (const prompt of [
      buildEditorialPrompt({ candidates: [candidate("current")], memories: [], storyDossiers }),
      buildBriefingPrompt({ date: "2026-07-25", candidates: [candidate("current")], memories: [], storyDossiers }),
    ]) {
      const payload = JSON.parse(prompt.user) as { storyDossiers: typeof storyDossiers };
      expect(payload.storyDossiers[0]?.historicalSignals[0]?.summary).toHaveLength(320);
      expect(payload.storyDossiers[0]?.priorCoverage[0]?.summary).toHaveLength(320);
      expect(prompt.system).toContain("storyDossiers");
      expect(prompt.system).toContain("not current sources");
    }
  });
});
