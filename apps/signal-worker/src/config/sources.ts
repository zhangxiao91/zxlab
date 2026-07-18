import type { SignalCategory, SignalSourceType } from "@zxlab/signal-schema";

export interface SignalSourceConfig {
  id: string;
  name: string;
  type: SignalSourceType;
  enabled: boolean;
  categoryHint: SignalCategory;
  priority: number;
  url?: string;
  repository?: string;
  query?: string;
  feed?: "topstories" | "newstories" | "beststories";
  includePrereleases?: boolean;
  maxItemsPerRun: number;
  lookbackHours: number;
  tags: string[];
}

export const SIGNAL_SOURCES: readonly SignalSourceConfig[] = [
  {
    id: "cloudflare-developer-platform",
    name: "Cloudflare Developer Platform Changelog",
    type: "rss",
    enabled: true,
    categoryHint: "zxlab",
    priority: 100,
    url: "https://developers.cloudflare.com/changelog/rss/developer-platform.xml",
    maxItemsPerRun: 24,
    lookbackHours: 168,
    tags: ["cloudflare", "workers", "d1", "workflows", "ai-gateway"],
  },
  {
    id: "github-workers-sdk-releases",
    name: "cloudflare/workers-sdk Releases",
    type: "github-release",
    enabled: false,
    categoryHint: "zxlab",
    priority: 90,
    repository: "cloudflare/workers-sdk",
    includePrereleases: false,
    maxItemsPerRun: 12,
    lookbackHours: 336,
    tags: ["cloudflare", "workers", "open-source", "sdk"],
  },
  {
    id: "github-openai-node-releases",
    name: "openai/openai-node Releases",
    type: "github-release",
    enabled: false,
    categoryHint: "ai-engineering",
    priority: 85,
    repository: "openai/openai-node",
    includePrereleases: false,
    maxItemsPerRun: 12,
    lookbackHours: 336,
    tags: ["openai", "sdk", "api", "open-source"],
  },
  {
    id: "hn-ai-engineering",
    name: "Hacker News AI Engineering",
    type: "hacker-news",
    enabled: true,
    categoryHint: "ai-engineering",
    priority: 50,
    feed: "beststories",
    query: "agent,agents,llm,inference,benchmark,context,mcp,model api,ai infrastructure,tool use,cloudflare workers",
    maxItemsPerRun: 24,
    lookbackHours: 48,
    tags: ["community", "discovery", "engineering"],
  },
  {
    id: "arxiv-agent-infra",
    name: "arXiv Agents and AI Infrastructure",
    type: "arxiv",
    enabled: true,
    categoryHint: "ai-engineering",
    priority: 60,
    query: "(cat:cs.AI OR cat:cs.LG OR cat:cs.CL) AND (ti:agent OR abs:\"agent evaluation\" OR abs:benchmark OR abs:\"long context\" OR abs:\"tool use\" OR abs:inference)",
    maxItemsPerRun: 24,
    lookbackHours: 168,
    tags: ["paper", "agent", "benchmark", "infra"],
  },
] as const;

export function findSource(id: string): SignalSourceConfig | undefined {
  return SIGNAL_SOURCES.find((source) => source.id === id);
}
