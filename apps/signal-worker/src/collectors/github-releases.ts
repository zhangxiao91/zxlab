import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";

interface GitHubRelease {
  id?: number;
  name?: string | null;
  tag_name?: string;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  created_at?: string;
  author?: { login?: string; html_url?: string } | null;
}

export function transformGitHubReleases(value: unknown, source: SignalSourceConfig): RawCollectedItem[] {
  if (!Array.isArray(value)) throw new SignalError("INVALID_SOURCE_RESPONSE", "GitHub releases response must be an array", 502);
  return value.flatMap((raw): RawCollectedItem[] => {
    const release = raw as GitHubRelease;
    if (!release.id || !release.html_url || !release.tag_name || release.draft) return [];
    if (release.prerelease && !source.includePrereleases) return [];
    return [{
      externalId: String(release.id),
      title: release.name?.trim() || release.tag_name,
      url: release.html_url,
      summary: release.body ?? undefined,
      authorName: release.author?.login,
      authorUrl: release.author?.html_url,
      publishedAt: release.published_at ?? release.created_at,
      updatedAt: release.published_at ?? undefined,
      metadata: { tagName: release.tag_name, prerelease: Boolean(release.prerelease), draft: false },
    }];
  });
}

export class GitHubReleaseCollector implements SignalCollector {
  readonly type = "github-release" as const;
  constructor(private readonly token?: string, private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!source.repository) throw new SignalError("INVALID_SOURCE_RESPONSE", "GitHub repository is missing", 500);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "zxlab-signal-collector",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetchSource(this.fetcher,
      `https://api.github.com/repos/${source.repository}/releases?per_page=${Math.min(source.maxItemsPerRun, 100)}`, {
        headers,
        expectedTypes: ["application/json"],
      });
    return transformGitHubReleases(await response.json(), source).slice(0, source.maxItemsPerRun);
  }
}
