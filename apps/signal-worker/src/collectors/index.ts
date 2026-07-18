import type { SignalSourceType } from "@zxlab/signal-schema";
import { ArxivCollector } from "./arxiv";
import { GitHubReleaseCollector } from "./github-releases";
import { HackerNewsCollector } from "./hacker-news";
import { RssCollector } from "./rss";
import type { SignalCollector } from "./types";

export function createCollectors(env: Env, fetcher: typeof fetch = fetch): Map<SignalSourceType, SignalCollector> {
  return new Map<SignalSourceType, SignalCollector>([
    ["rss", new RssCollector(fetcher)],
    ["github-release", new GitHubReleaseCollector(env.GITHUB_TOKEN, fetcher)],
    ["hacker-news", new HackerNewsCollector(fetcher)],
    ["arxiv", new ArxivCollector(env.ZX_SIGNAL_USER_AGENT, fetcher)],
  ]);
}
