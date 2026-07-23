import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";

// The scheduled Signal pipeline also fetches 17 other sources and calls the AI gateway twice.
// Keep both Hacker News feeds comfortably below the Worker subrequest limit.
const STORY_PROBE_LIMIT = 10;

interface HackerNewsStory {
  id?: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  deleted?: boolean;
  dead?: boolean;
}

export function transformHackerNewsStory(value: unknown): RawCollectedItem | null {
  const story = value as HackerNewsStory;
  if (!story || story.type !== "story" || !story.id || !story.title || story.deleted || story.dead || !story.time) return null;
  const discussionUrl = `https://news.ycombinator.com/item?id=${story.id}`;
  return {
    externalId: String(story.id),
    title: story.title,
    url: story.url ?? discussionUrl,
    summary: story.text,
    authorName: story.by,
    authorUrl: story.by ? `https://news.ycombinator.com/user?id=${encodeURIComponent(story.by)}` : undefined,
    publishedAt: new Date(story.time * 1_000).toISOString(),
    metadata: { score: story.score ?? 0, descendants: story.descendants ?? 0, discussionUrl },
  };
}

function recalled(item: RawCollectedItem, source: SignalSourceConfig): boolean {
  const keywords = source.query?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
  if (!keywords.length) return true;
  const domain = (() => { try { return new URL(item.url).hostname.toLowerCase(); } catch { return ""; } })();
  const haystack = `${item.title} ${domain}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

export class HackerNewsCollector implements SignalCollector {
  readonly type = "hacker-news" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, context: CollectionContext): Promise<RawCollectedItem[]> {
    const feed = source.feed ?? "beststories";
    const idsResponse = await fetchSource(this.fetcher, `https://hacker-news.firebaseio.com/v0/${feed}.json`, { expectedTypes: ["application/json"] });
    const ids = await idsResponse.json();
    if (!Array.isArray(ids)) throw new SignalError("INVALID_SOURCE_RESPONSE", "Hacker News story list was invalid", 502);
    const probeCount = Math.min(ids.length, STORY_PROBE_LIMIT);
    const stories = await Promise.all(ids.slice(0, probeCount).map(async (id) => {
      if (typeof id !== "number") return null;
      try {
        const response = await fetchSource(this.fetcher, `https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeoutMs: 8_000, expectedTypes: ["application/json"] });
        return transformHackerNewsStory(await response.json());
      } catch { return null; }
    }));
    const since = Date.parse(context.since ?? new Date(Date.parse(context.now) - source.lookbackHours * 3_600_000).toISOString());
    return stories.filter((item): item is RawCollectedItem => Boolean(item))
      .filter((item) => Date.parse(item.publishedAt ?? "") >= since && recalled(item, source))
      .slice(0, source.maxItemsPerRun);
  }
}
