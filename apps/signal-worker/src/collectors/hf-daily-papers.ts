import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";

interface HuggingFacePaper {
  id?: string;
  title?: string;
  summary?: string;
  paper?: { id?: string; title?: string; summary?: string; authors?: string[]; publishedAt?: string; url?: string };
  publishedAt?: string;
  submittedOnDailyAt?: string;
  upvotes?: number;
  numUpvotes?: number;
}

function paperId(item: HuggingFacePaper): string | undefined {
  return item.paper?.id ?? item.id;
}

export function transformHfDailyPapers(value: unknown): RawCollectedItem[] {
  const rows = Array.isArray(value) ? value : (value as { papers?: unknown[]; data?: unknown[] }).papers ?? (value as { data?: unknown[] }).data;
  if (!Array.isArray(rows)) throw new SignalError("INVALID_SOURCE_RESPONSE", "Hugging Face Daily Papers response was invalid", 502);
  return rows.flatMap((raw): RawCollectedItem[] => {
    const item = raw as HuggingFacePaper;
    const id = paperId(item);
    const title = item.paper?.title ?? item.title;
    if (!id || !title) return [];
    const url = item.paper?.url ?? `https://huggingface.co/papers/${encodeURIComponent(id)}`;
    return [{
      externalId: id,
      title,
      url,
      summary: item.paper?.summary ?? item.summary,
      authorName: item.paper?.authors?.join(", "),
      publishedAt: item.submittedOnDailyAt ?? item.paper?.publishedAt ?? item.publishedAt,
      metadata: { hfPaperId: id, upvotes: item.upvotes ?? item.numUpvotes ?? 0 },
    }];
  });
}

export class HfDailyPapersCollector implements SignalCollector {
  readonly type = "hf-daily-papers" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    const response = await fetchSource(this.fetcher, "https://huggingface.co/api/daily_papers", {
      headers: { Accept: "application/json" },
      expectedTypes: ["application/json"],
      timeoutMs: 15_000,
    });
    return transformHfDailyPapers(await response.json()).slice(0, source.maxItemsPerRun);
  }
}
