import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";
import { xmlAttr, xmlBlocks, xmlText } from "./xml";

export function parseArxivFeed(xml: string): RawCollectedItem[] {
  return xmlBlocks(xml, "entry").flatMap((entry): RawCollectedItem[] => {
    const idUrl = xmlText(entry, "id");
    const title = xmlText(entry, "title");
    const abstract = xmlText(entry, "summary");
    if (!idUrl || !title || !abstract) return [];
    const externalId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    const authors = xmlBlocks(entry, "author").map((author) => xmlText(author, "name")).filter((name): name is string => Boolean(name));
    const categories = [...entry.matchAll(/<(?:[\w-]+:)?category\b[^>]*\bterm=["']([^"']+)["'][^>]*\/?>/gi)].map((match) => match[1] ?? "").filter(Boolean);
    const primaryCategory = xmlAttr(entry, "primary_category", "term") ?? categories[0];
    return [{
      externalId,
      title,
      url: idUrl,
      summary: abstract,
      authorName: authors.join(", "),
      publishedAt: xmlText(entry, "published"),
      updatedAt: xmlText(entry, "updated"),
      metadata: {
        authors,
        categories,
        primaryCategory,
        pdfUrl: `https://arxiv.org/pdf/${externalId}`,
      },
    }];
  });
}

export class ArxivCollector implements SignalCollector {
  readonly type = "arxiv" as const;
  constructor(private readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!source.query) throw new SignalError("INVALID_SOURCE_RESPONSE", "arXiv query is missing", 500);
    const params = new URLSearchParams({ search_query: source.query, start: "0", max_results: String(source.maxItemsPerRun), sortBy: "submittedDate", sortOrder: "descending" });
    const response = await fetchSource(this.fetcher, `https://export.arxiv.org/api/query?${params}`, {
      headers: { Accept: "application/atom+xml", "User-Agent": this.userAgent },
      expectedTypes: ["xml", "atom"],
      timeoutMs: 20_000,
    });
    const items = parseArxivFeed(await response.text());
    if (!items.length) throw new SignalError("INVALID_SOURCE_RESPONSE", "arXiv feed contained no valid entries", 502);
    return items.slice(0, source.maxItemsPerRun);
  }
}
