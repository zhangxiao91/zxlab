import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SignalSourceType } from "@zxlab/signal-schema";
import type { SignalCollector } from "../src/collectors/types";
import { parseArxivFeed } from "../src/collectors/arxiv";
import { transformGitHubReleases } from "../src/collectors/github-releases";
import { transformHackerNewsStory } from "../src/collectors/hacker-news";
import { transformHfDailyPapers } from "../src/collectors/hf-daily-papers";
import { transformMarketNews } from "../src/collectors/market-news";
import { transformProductHuntPosts } from "../src/collectors/producthunt";
import { parseFeed } from "../src/collectors/rss";
import { parseWebChangelog } from "../src/collectors/web-changelog";
import { findSource } from "../src/config/sources";
import { CollectionRepository } from "../src/repositories/collection-repository";
import { CollectionService } from "../src/services/collection-service";

const collector: SignalCollector = {
  type: "rss",
  async collect() {
    return [{
      externalId: "release-1",
      title: "Workers runtime update",
      url: "https://developers.cloudflare.com/changelog/example/?utm_source=test",
      summary: "A concrete runtime capability changed.",
      publishedAt: "2026-07-18T08:00:00.000Z",
    }];
  },
};

describe("Signal collection pipeline", () => {
  it("parses RSS, arXiv, Hacker News, GitHub release and new source shapes", () => {
    expect(parseFeed(`<rss><channel><item><guid>rss-1</guid><title>Runtime &amp; API</title><link>https://example.com/rss</link><description><![CDATA[<p>Details</p>]]></description><pubDate>Sat, 18 Jul 2026 08:00:00 GMT</pubDate></item></channel></rss>`)[0])
      .toMatchObject({ externalId: "rss-1", title: "Runtime & API", url: "https://example.com/rss" });
    expect(parseArxivFeed(`<feed><entry><id>https://arxiv.org/abs/2607.12345v2</id><title>Agent Evaluation</title><summary>Measured results</summary><published>2026-07-18T08:00:00Z</published><author><name>Researcher</name></author><category term="cs.AI"/></entry></feed>`)[0])
      .toMatchObject({ externalId: "2607.12345", title: "Agent Evaluation" });
    expect(transformHackerNewsStory({ id: 42, type: "story", by: "builder", time: 1_784_361_600, title: "LLM infrastructure", score: 10 }))
      .toMatchObject({ externalId: "42", url: "https://news.ycombinator.com/item?id=42" });
    const source = findSource("github-workers-sdk-releases");
    expect(source && transformGitHubReleases([{ id: 7, tag_name: "v7", html_url: "https://github.com/cloudflare/workers-sdk/releases/tag/v7" }], source)[0])
      .toMatchObject({ externalId: "7", title: "v7" });
    expect(transformProductHuntPosts({ data: { posts: { edges: [{ node: { id: "p1", name: "AgentKit", tagline: "Build agents", url: "https://www.producthunt.com/posts/agentkit", website: "https://example.com" } }] } } })[0])
      .toMatchObject({ externalId: "p1", title: "AgentKit", url: "https://example.com" });
    expect(transformHfDailyPapers([{ paper: { id: "2607.1", title: "Long Context Agents" }, submittedOnDailyAt: "2026-07-18T08:00:00Z" }])[0])
      .toMatchObject({ externalId: "2607.1", url: "https://huggingface.co/papers/2607.1" });
    const changelogSource = findSource("google-gemini-official-updates");
    expect(changelogSource && parseWebChangelog(`<main><time>July 18, 2026</time><a href="/gemini-api/docs/changelog#models">Gemini API model update</a></main>`, changelogSource)[0])
      .toMatchObject({ title: "Gemini API model update", url: "https://ai.google.dev/gemini-api/docs/changelog#models" });
    expect(transformMarketNews({ data: [{ id: "n1", title: "ETF announcement", url: "https://example.com/news", source: "cninfo-announcement", type: "announcement" }] })[0])
      .toMatchObject({ externalId: "n1", title: "ETF announcement" });
  });

  it("persists normalized candidates and records later sightings as duplicates", async () => {
    const collectors = new Map<SignalSourceType, SignalCollector>([["rss", collector]]);
    const service = new CollectionService(env, collectors);
    const input = { sourceIds: ["cloudflare-developer-platform"] };

    const first = await service.run(input, { runId: "collection-test-1", now: "2026-07-18T10:00:00.000Z" });
    expect(first.status).toBe("succeeded");
    expect(first.insertedCount).toBe(1);
    expect(first.sources).toHaveLength(1);

    const repository = new CollectionRepository(env.DB);
    const page = await repository.listCandidates({ collectionRunId: first.id });
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]).toMatchObject({
      title: "Workers runtime update",
      canonicalUrl: "https://developers.cloudflare.com/changelog/example",
      status: "eligible",
    });

    const second = await service.run(input, { runId: "collection-test-2", now: "2026-07-18T11:00:00.000Z" });
    expect(second.status).toBe("succeeded");
    expect(second.insertedCount).toBe(0);
    expect(second.duplicateCount).toBe(1);
  });

  it("skips missing-secret sources by default but rejects explicit requests", async () => {
    const service = new CollectionService(env, new Map());
    await expect(service.run({ sourceTypes: ["producthunt"] }, { runId: "missing-secret-default", now: "2026-07-18T10:00:00.000Z" }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    await expect(service.run({ sourceIds: ["producthunt-ai-devtools"] }, { runId: "missing-secret-explicit", now: "2026-07-18T10:00:00.000Z" }))
      .rejects.toMatchObject({ code: "SOURCE_DISABLED" });
  });

  it("deduplicates different URLs with the same title and summary inside a dedup group", async () => {
    const groupedCollector: SignalCollector = {
      type: "rss",
      async collect(source) {
        return [{
          externalId: `${source.id}-same-story`,
          title: "Same AI release",
          url: `https://example.com/${source.id}/story`,
          summary: "The same update was syndicated.",
          publishedAt: "2026-07-18T08:00:00.000Z",
        }];
      },
    };
    const service = new CollectionService(env, new Map<SignalSourceType, SignalCollector>([["rss", groupedCollector]]));
    const run = await service.run({ sourceIds: ["linuxdo-develop", "linuxdo-news"] }, { runId: "content-hash-dedup", now: "2026-07-18T10:00:00.000Z" });
    expect(run.status).toBe("succeeded");
    expect(run.insertedCount).toBe(2);
    expect(run.duplicateCount).toBe(1);
    const repository = new CollectionRepository(env.DB);
    const page = await repository.listCandidates({ collectionRunId: run.id });
    expect(page.candidates.map((item) => item.status).sort()).toEqual(["duplicate", "eligible"]);
    expect(page.candidates.find((item) => item.status === "duplicate")?.dedupReason).toBe("content-hash");
  });
});
