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

interface ProductHuntPageInfo {
  hasNextPage?: boolean;
  endCursor?: string;
}

interface ProductHuntPostsPage {
  edges: Array<{ node?: ProductHuntPost }>;
  pageInfo?: ProductHuntPageInfo;
}

const PRODUCT_HUNT_PAGE_SIZE = 50;
const PRODUCT_HUNT_MAX_PAGES = 3;
const PRODUCT_HUNT_MAX_SCANNED_POSTS = 150;
const PRODUCT_HUNT_MAX_MATCHES = 20;

function parseProductHuntPostsPage(value: unknown): ProductHuntPostsPage {
  const posts = (value as { data?: { posts?: ProductHuntPostsPage } }).data?.posts;
  if (!posts || !Array.isArray(posts.edges)) {
    throw new SignalError("INVALID_SOURCE_RESPONSE", "Product Hunt posts response was invalid", 502);
  }
  return posts;
}

export function transformProductHuntPosts(value: unknown, source?: SignalSourceConfig): RawCollectedItem[] {
  const posts = parseProductHuntPostsPage(value).edges;
  const topicFilters = source?.topics?.map((topic) => topic.toLowerCase()) ?? [];
  return posts.flatMap((edge): RawCollectedItem[] => {
    const post = edge.node;
    if (!post?.id || !post.name || !post.url) return [];
    const topics = post.topics?.edges?.map((topic) => topic.node?.name).filter((name): name is string => Boolean(name)) ?? [];
    const normalizedTopics = new Set(topics.map((topic) => topic.normalize("NFKC").trim().toLowerCase()));
    if (topicFilters.length && !topicFilters.some((topic) => normalizedTopics.has(topic))) return [];
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

  async collect(source: SignalSourceConfig, context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!this.token) throw new SignalError("SOURCE_DISABLED", "Product Hunt source requires PRODUCTHUNT_DEVELOPER_TOKEN", 409);
    const query = `query SignalProductHunt($first: Int!, $after: String, $postedAfter: DateTime) {
      posts(first: $first, after: $after, postedAfter: $postedAfter, order: NEWEST) {
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
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const resultLimit = Math.min(source.maxItemsPerRun, PRODUCT_HUNT_MAX_MATCHES);
    const matches = new Map<string, RawCollectedItem>();
    let after: string | undefined;
    let scanned = 0;

    for (let page = 0; page < PRODUCT_HUNT_MAX_PAGES && scanned < PRODUCT_HUNT_MAX_SCANNED_POSTS && matches.size < resultLimit; page += 1) {
      const first = Math.min(PRODUCT_HUNT_PAGE_SIZE, PRODUCT_HUNT_MAX_SCANNED_POSTS - scanned);
      const response = await fetchSource(this.fetcher, "https://api.producthunt.com/v2/api/graphql", {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { first, after, postedAfter: context.since } }),
        expectedTypes: ["application/json"],
        timeoutMs: 15_000,
      });
      const value: unknown = await response.json();
      const posts = parseProductHuntPostsPage(value);
      const boundedEdges = posts.edges.slice(0, first);
      scanned += boundedEdges.length;
      for (const item of transformProductHuntPosts({ data: { posts: { edges: boundedEdges } } }, source)) {
        if (!matches.has(item.externalId)) matches.set(item.externalId, item);
        if (matches.size >= resultLimit) break;
      }
      if (!posts.pageInfo?.hasNextPage || !posts.pageInfo.endCursor) break;
      after = posts.pageInfo.endCursor;
    }

    return [...matches.values()].slice(0, resultLimit);
  }
}
