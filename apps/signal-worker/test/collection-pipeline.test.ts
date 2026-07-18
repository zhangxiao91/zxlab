import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SignalSourceType } from "@zxlab/signal-schema";
import type { SignalCollector } from "../src/collectors/types";
import { parseArxivFeed } from "../src/collectors/arxiv";
import { transformGitHubReleases } from "../src/collectors/github-releases";
import { transformHackerNewsStory } from "../src/collectors/hacker-news";
import { parseFeed } from "../src/collectors/rss";
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
  it("parses RSS, arXiv, Hacker News and GitHub release source shapes", () => {
    expect(parseFeed(`<rss><channel><item><guid>rss-1</guid><title>Runtime &amp; API</title><link>https://example.com/rss</link><description><![CDATA[<p>Details</p>]]></description><pubDate>Sat, 18 Jul 2026 08:00:00 GMT</pubDate></item></channel></rss>`)[0])
      .toMatchObject({ externalId: "rss-1", title: "Runtime & API", url: "https://example.com/rss" });
    expect(parseArxivFeed(`<feed><entry><id>https://arxiv.org/abs/2607.12345v2</id><title>Agent Evaluation</title><summary>Measured results</summary><published>2026-07-18T08:00:00Z</published><author><name>Researcher</name></author><category term="cs.AI"/></entry></feed>`)[0])
      .toMatchObject({ externalId: "2607.12345", title: "Agent Evaluation" });
    expect(transformHackerNewsStory({ id: 42, type: "story", by: "builder", time: 1_784_361_600, title: "LLM infrastructure", score: 10 }))
      .toMatchObject({ externalId: "42", url: "https://news.ycombinator.com/item?id=42" });
    const source = findSource("github-workers-sdk-releases");
    expect(source && transformGitHubReleases([{ id: 7, tag_name: "v7", html_url: "https://github.com/cloudflare/workers-sdk/releases/tag/v7" }], source)[0])
      .toMatchObject({ externalId: "7", title: "v7" });
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
});
