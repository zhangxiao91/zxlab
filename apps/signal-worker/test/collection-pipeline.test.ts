import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SignalSourceType } from "@zxlab/signal-schema";
import type { SignalCollector } from "../src/collectors/types";
import { parseArxivFeed } from "../src/collectors/arxiv";
import { transformGitHubReleases } from "../src/collectors/github-releases";
import { HackerNewsCollector, transformHackerNewsStory } from "../src/collectors/hacker-news";
import { transformHfDailyPapers } from "../src/collectors/hf-daily-papers";
import { transformMarketNews } from "../src/collectors/market-news";
import { ProductHuntCollector, transformProductHuntPosts } from "../src/collectors/producthunt";
import { parseFeed } from "../src/collectors/rss";
import { parseWebChangelog, WebChangelogCollector } from "../src/collectors/web-changelog";
import { findSource } from "../src/config/sources";
import { CollectionRepository } from "../src/repositories/collection-repository";
import { CollectionService } from "../src/services/collection-service";
import { SignalError } from "../src/lib/errors";

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
  it("configures Product Hunt for the personal product-discovery interests", () => {
    expect(findSource("producthunt-ai-devtools")?.topics).toEqual([
      "Artificial Intelligence",
      "Developer Tools",
      "Productivity",
      "Personal Knowledge Management",
      "Research Tools",
      "Design Tools",
    ]);
  });

  it("matches Product Hunt against exact API topics rather than launch copy", () => {
    const source = findSource("producthunt-ai-devtools");
    const items = transformProductHuntPosts({ data: { posts: { edges: [
      { node: {
        id: "copy-only",
        name: "Design Tools for Games",
        tagline: "AI productivity for every developer",
        url: "https://www.producthunt.com/posts/copy-only",
        topics: { edges: [{ node: { name: "Games" } }] },
      } },
      { node: {
        id: "topic-match",
        name: "Focused Workspace",
        tagline: "A calm place to work",
        url: "https://www.producthunt.com/posts/topic-match",
        topics: { edges: [{ node: { name: "Productivity" } }] },
      } },
    ] } } }, source);

    expect(items.map((item) => item.externalId)).toEqual(["topic-match"]);
  });

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

  it("collects OpenAI updates from the current official API changelog", async () => {
    const requestedUrls: string[] = [];
    const collector = new WebChangelogCollector(async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        `<main><time>August 21, 2026</time><a href="/api/docs/changelog/#responses">Responses API update</a></main>`,
        { headers: { "content-type": "text/html" } },
      );
    });
    const source = findSource("openai-official-updates");

    expect(source).toBeDefined();
    const items = await collector.collect(source!, {
      runId: "openai-official-source",
      now: "2026-08-23T00:00:00.000Z",
      since: "2026-08-16T00:00:00.000Z",
    });

    expect(requestedUrls).toEqual(["https://developers.openai.com/api/docs/changelog/"]);
    expect(items[0]).toMatchObject({
      title: "Responses API update",
      url: "https://developers.openai.com/api/docs/changelog/#responses",
    });
  });

  it("caps Hacker News probes so the daily Worker retains gateway subrequest capacity", async () => {
    let requests = 0;
    const collector = new HackerNewsCollector(async (input) => {
      requests += 1;
      const url = String(input);
      if (url.endsWith("beststories.json")) {
        return new Response(JSON.stringify(Array.from({ length: 20 }, (_, index) => index + 1)), { headers: { "content-type": "application/json" } });
      }
      const id = Number(url.match(/item\/(\d+)\.json/)?.[1]);
      return new Response(JSON.stringify({ id, type: "story", by: "builder", time: 1_784_361_600, title: `Agent tool ${id}`, score: 10 }), { headers: { "content-type": "application/json" } });
    });
    const source = findSource("hn-ai-engineering");
    expect(source).toBeDefined();
    const items = await collector.collect(source!, { runId: "hn-budget", now: "2026-07-18T10:00:00.000Z", since: "2026-07-18T00:00:00.000Z" });
    expect(requests).toBe(11);
    expect(items).toHaveLength(6);
  });

  it("paginates Product Hunt safely until it finds 20 configured-topic products", async () => {
    const requests: Array<{ first?: number; after?: string; postedAfter?: string }> = [];
    const pages = Array.from({ length: 3 }, (_, pageIndex) => ({
      data: {
        posts: {
          edges: Array.from({ length: 50 }, (_, itemIndex) => {
            const id = pageIndex * 50 + itemIndex + 1;
            return {
              node: {
                id: `ph-${id}`,
                name: `Launch ${id}`,
                tagline: itemIndex < 8 ? "A focused maker tool" : "A new game",
                url: `https://www.producthunt.com/posts/launch-${id}`,
                createdAt: "2026-07-18T08:00:00.000Z",
                topics: { edges: [{ node: { name: itemIndex < 8 ? "Developer Tools" : "Games" } }] },
              },
            };
          }),
          pageInfo: { hasNextPage: true, endCursor: `cursor-${pageIndex + 1}` },
        },
      },
    }));
    const collector = new ProductHuntCollector("developer-token", async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { first?: number; after?: string; postedAfter?: string } };
      requests.push(body.variables ?? {});
      return new Response(JSON.stringify(pages[requests.length - 1]), { headers: { "content-type": "application/json" } });
    });
    const source = findSource("producthunt-ai-devtools");

    const items = await collector.collect(source!, {
      runId: "producthunt-pagination",
      now: "2026-07-18T10:00:00.000Z",
      since: "2026-07-15T10:00:00.000Z",
    });

    expect(items).toHaveLength(20);
    expect(items[0]?.externalId).toBe("ph-1");
    expect(items[19]?.externalId).toBe("ph-104");
    expect(requests).toEqual([
      { first: 50, postedAfter: "2026-07-15T10:00:00.000Z" },
      { first: 50, after: "cursor-1", postedAfter: "2026-07-15T10:00:00.000Z" },
      { first: 50, after: "cursor-2", postedAfter: "2026-07-15T10:00:00.000Z" },
    ]);
  });

  it("stops Product Hunt pagination at three pages even when more pages exist", async () => {
    let requests = 0;
    const collector = new ProductHuntCollector("developer-token", async () => {
      requests += 1;
      return new Response(JSON.stringify({
        data: {
          posts: {
            edges: Array.from({ length: 50 }, (_, itemIndex) => ({
              node: {
                id: `page-${requests}-post-${itemIndex}`,
                name: `Unrelated launch ${itemIndex}`,
                tagline: "A game",
                url: `https://www.producthunt.com/posts/unrelated-${requests}-${itemIndex}`,
                topics: { edges: [{ node: { name: "Games" } }] },
              },
            })),
            pageInfo: { hasNextPage: true, endCursor: `cursor-${requests}` },
          },
        },
      }), { headers: { "content-type": "application/json" } });
    });
    const source = findSource("producthunt-ai-devtools");

    const items = await collector.collect(source!, { runId: "producthunt-page-cap", now: "2026-07-18T10:00:00.000Z" });

    expect(items).toEqual([]);
    expect(requests).toBe(3);
  });

  it("ignores Product Hunt posts beyond the 150-post scan budget", async () => {
    const collector = new ProductHuntCollector("developer-token", async () => new Response(JSON.stringify({
      data: {
        posts: {
          edges: Array.from({ length: 151 }, (_, itemIndex) => ({
            node: {
              id: `scan-${itemIndex + 1}`,
              name: `Launch ${itemIndex + 1}`,
              tagline: itemIndex === 150 ? "Developer workflow" : "A game",
              url: `https://www.producthunt.com/posts/scan-${itemIndex + 1}`,
              topics: { edges: [{ node: { name: itemIndex === 150 ? "Developer Tools" : "Games" } }] },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }), { headers: { "content-type": "application/json" } }));
    const source = findSource("producthunt-ai-devtools");

    const items = await collector.collect(source!, { runId: "producthunt-scan-cap", now: "2026-07-18T10:00:00.000Z" });

    expect(items).toEqual([]);
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

  it("retries a source sync after a transient D1 storage timeout", async () => {
    let attempts = 0;
    const batches: D1PreparedStatement[][] = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) { return { query, values }; },
        } as unknown as D1PreparedStatement;
      },
      async batch(statements: D1PreparedStatement[]) {
        attempts += 1;
        batches.push(statements);
        if (attempts === 1) throw new Error("D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.");
        return [];
      },
    } as unknown as D1Database;
    const repository = new CollectionRepository(db);
    const source = findSource("cloudflare-developer-platform");

    await repository.syncSources([source!], "2026-08-06T00:00:00.000Z", {
      maxAttempts: 2,
      retryDelaysMs: [0],
      sleep: async () => {},
    });

    expect(attempts).toBe(2);
    expect(batches).toHaveLength(2);
    expect(batches[0]).not.toBe(batches[1]);
  });

  it("skips missing-secret sources by default but rejects explicit requests", async () => {
    const service = new CollectionService(env, new Map());
    await expect(service.run({ sourceTypes: ["producthunt"] }, { runId: "missing-secret-default", now: "2026-07-18T10:00:00.000Z" }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    await expect(service.run({ sourceIds: ["producthunt-ai-devtools"] }, { runId: "missing-secret-explicit", now: "2026-07-18T10:00:00.000Z" }))
      .rejects.toMatchObject({ code: "SOURCE_DISABLED" });
  });

  it("preserves source failure details in the collection summary", async () => {
    const failingCollector: SignalCollector = {
      type: "rss",
      async collect() { throw new SignalError("SOURCE_FETCH_FAILED", "Source returned HTTP 403", 502); },
    };
    const service = new CollectionService(env, new Map<SignalSourceType, SignalCollector>([["rss", failingCollector]]));
    const run = await service.run({ sourceIds: ["cloudflare-developer-platform"] }, { runId: "source-error-detail", now: "2026-07-18T10:00:00.000Z" });
    expect(run.errorSummary).toBe("cloudflare-developer-platform:SOURCE_FETCH_FAILED");
    expect(run.sources[0]).toMatchObject({ errorCode: "SOURCE_FETCH_FAILED" });
    expect(run.sources[0]?.errorMessage).toBeUndefined();
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
