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
    const briefing = buildBriefingPrompt({ date: "2026-07-25", candidates: [candidate("release")], memories: [] });
    const editorial = buildEditorialPrompt({ candidates: [candidate("release")], memories: [] });
    expect(briefing.system).toContain("never more than one third of the briefing");
    expect(editorial.system).toContain("no more than one third of keep decisions");
    expect(editorial.system).toContain("public significance");
  });
});
