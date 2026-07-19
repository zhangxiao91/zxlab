import type { SignalSourceType } from "@zxlab/signal-schema";
import { ArxivCollector } from "./arxiv";
import { GitHubReleaseCollector } from "./github-releases";
import { HackerNewsCollector } from "./hacker-news";
import { HfDailyPapersCollector } from "./hf-daily-papers";
import { MarketNewsCollector } from "./market-news";
import { ProductHuntCollector } from "./producthunt";
import { RssCollector } from "./rss";
import type { SignalCollector } from "./types";
import { WebChangelogCollector } from "./web-changelog";

export function createCollectors(env: Env, fetcher: typeof fetch = fetch): Map<SignalSourceType, SignalCollector> {
  return new Map<SignalSourceType, SignalCollector>([
    ["rss", new RssCollector(fetcher)],
    ["github-release", new GitHubReleaseCollector(env.GITHUB_TOKEN, fetcher)],
    ["hacker-news", new HackerNewsCollector(fetcher)],
    ["arxiv", new ArxivCollector(env.ZX_SIGNAL_USER_AGENT, fetcher)],
    ["producthunt", new ProductHuntCollector(env.PRODUCTHUNT_DEVELOPER_TOKEN, fetcher)],
    ["hf-daily-papers", new HfDailyPapersCollector(fetcher)],
    ["web-changelog", new WebChangelogCollector(fetcher)],
    ["market-news", new MarketNewsCollector(env.ZX_SIGNAL_MARKET_NEWS_URL, fetcher)],
  ]);
}
