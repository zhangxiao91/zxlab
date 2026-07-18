import { SignalError } from "../lib/errors";
import type { SignalSourceConfig } from "../config/sources";
import { fetchSource } from "./http";
import type { CollectionContext, RawCollectedItem, SignalCollector } from "./types";
import { xmlAttr, xmlBlocks, xmlText } from "./xml";

function parseRssItem(block: string): RawCollectedItem | null {
  const title = xmlText(block, "title");
  const url = xmlText(block, "link");
  if (!title || !url) return null;
  return {
    externalId: xmlText(block, "guid") ?? url,
    title,
    url,
    summary: xmlText(block, "description", "encoded"),
    authorName: xmlText(block, "author", "creator"),
    publishedAt: xmlText(block, "pubDate", "date"),
  };
}

function parseAtomEntry(block: string): RawCollectedItem | null {
  const title = xmlText(block, "title");
  const url = xmlAttr(block, "link", "href", "alternate") ?? xmlAttr(block, "link", "href");
  if (!title || !url) return null;
  const authorBlock = xmlBlocks(block, "author")[0] ?? "";
  return {
    externalId: xmlText(block, "id") ?? url,
    title,
    url,
    summary: xmlText(block, "summary", "content"),
    authorName: xmlText(authorBlock, "name"),
    authorUrl: xmlText(authorBlock, "uri"),
    publishedAt: xmlText(block, "published", "updated"),
    updatedAt: xmlText(block, "updated"),
  };
}

export function parseFeed(xml: string): RawCollectedItem[] {
  const rssItems = xmlBlocks(xml, "item").map(parseRssItem).filter((item): item is RawCollectedItem => Boolean(item));
  if (rssItems.length) return rssItems;
  const atomItems = xmlBlocks(xml, "entry").map(parseAtomEntry).filter((item): item is RawCollectedItem => Boolean(item));
  if (atomItems.length) return atomItems;
  throw new SignalError("INVALID_FEED", "Feed did not contain valid RSS items or Atom entries", 502);
}

export class RssCollector implements SignalCollector {
  readonly type = "rss" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async collect(source: SignalSourceConfig, _context: CollectionContext): Promise<RawCollectedItem[]> {
    if (!source.url) throw new SignalError("INVALID_SOURCE_RESPONSE", "RSS source URL is missing", 500);
    const response = await fetchSource(this.fetcher, source.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      expectedTypes: ["xml", "rss", "atom"],
    });
    return parseFeed(await response.text()).slice(0, source.maxItemsPerRun);
  }
}
