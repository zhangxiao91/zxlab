import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";
import { plainText } from "../services/candidate-normalizer";

interface WebChangelogMatch {
  title: string;
  url: string;
  publishedAt?: string;
}

function absolute(base: string, value: string): string {
  try { return new URL(value, base).toString(); } catch { return base; }
}

function isoFromText(value: string): string | undefined {
  const iso = value.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso?.[1] && iso[2] && iso[3]) return new Date(`${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}T00:00:00Z`).toISOString();
  const named = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2}\b/i);
  if (named) {
    const parsed = Date.parse(named[0]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

export function parseWebChangelog(html: string, source: SignalSourceConfig): RawCollectedItem[] {
  if (!source.url) throw new SignalError("INVALID_SOURCE_RESPONSE", "Web changelog source URL is missing", 500);
  const matches: WebChangelogMatch[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{8,500}?)<\/a>/gi)) {
    const href = match[1];
    const text = plainText(match[2] ?? "", 240);
    if (!href || !text || text.length < 8) continue;
    const nearby = html.slice(Math.max(0, match.index - 320), Math.min(html.length, match.index + 500));
    matches.push({ title: text, url: absolute(source.url, href), publishedAt: isoFromText(plainText(nearby, 1_000)) });
  }
  const seen = new Set<string>();
  return matches.flatMap((item): RawCollectedItem[] => {
    const key = item.url;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      externalId: key,
      title: item.title,
      url: item.url,
      summary: item.publishedAt ? `Official update published around ${item.publishedAt.slice(0, 10)}.` : undefined,
      publishedAt: item.publishedAt,
      metadata: { selectorPreset: source.selectorPreset ?? "links" },
    }];
  }).slice(0, source.maxItemsPerRun);
}

export class WebChangelogCollector implements SignalCollector {
  readonly type = "web-changelog" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!source.url) throw new SignalError("INVALID_SOURCE_RESPONSE", "Web changelog source URL is missing", 500);
    const response = await fetchSource(this.fetcher, source.url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      expectedTypes: ["html", "text"],
      timeoutMs: 15_000,
    });
    return parseWebChangelog(await response.text(), source).slice(0, source.maxItemsPerRun);
  }
}
