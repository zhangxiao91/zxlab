import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";

interface ProductHuntPost {
  id?: string;
  name?: string;
  tagline?: string;
  description?: string;
  url?: string;
  website?: string;
  createdAt?: string;
  votesCount?: number;
  commentsCount?: number;
  topics?: { edges?: Array<{ node?: { name?: string } }> };
  user?: { name?: string; url?: string };
}

export function transformProductHuntPosts(value: unknown, source?: SignalSourceConfig): RawCollectedItem[] {
  const posts = (value as { data?: { posts?: { edges?: Array<{ node?: ProductHuntPost }> } } }).data?.posts?.edges;
  if (!Array.isArray(posts)) throw new SignalError("INVALID_SOURCE_RESPONSE", "Product Hunt posts response was invalid", 502);
  const topicFilters = source?.topics?.map((topic) => topic.toLowerCase()) ?? [];
  return posts.flatMap((edge): RawCollectedItem[] => {
    const post = edge.node;
    if (!post?.id || !post.name || !post.url) return [];
    const topics = post.topics?.edges?.map((topic) => topic.node?.name).filter((name): name is string => Boolean(name)) ?? [];
    const haystack = `${post.name} ${post.tagline ?? ""} ${topics.join(" ")}`.toLowerCase();
    if (topicFilters.length && !topicFilters.some((topic) => haystack.includes(topic))) return [];
    return [{
      externalId: post.id,
      title: post.name,
      url: post.website || post.url,
      summary: [post.tagline, post.description].filter(Boolean).join("\n\n") || undefined,
      authorName: post.user?.name,
      authorUrl: post.user?.url,
      publishedAt: post.createdAt,
      metadata: { productHuntUrl: post.url, votesCount: post.votesCount ?? 0, commentsCount: post.commentsCount ?? 0, topics },
    }];
  });
}

export class ProductHuntCollector implements SignalCollector {
  readonly type = "producthunt" as const;
  constructor(private readonly token?: string, private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!this.token) throw new SignalError("SOURCE_DISABLED", "Product Hunt source requires PRODUCTHUNT_DEVELOPER_TOKEN", 409);
    const query = `query SignalProductHunt($first: Int!) {
      posts(first: $first, order: NEWEST) {
        edges {
          node {
            id
            name
            tagline
            description
            url
            website
            createdAt
            votesCount
            commentsCount
            user { name url }
            topics { edges { node { name } } }
          }
        }
      }
    }`;
    const response = await fetchSource(this.fetcher, "https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { first: Math.min(source.maxItemsPerRun, 50) } }),
      expectedTypes: ["application/json"],
      timeoutMs: 15_000,
    });
    return transformProductHuntPosts(await response.json(), source).slice(0, source.maxItemsPerRun);
  }
}
