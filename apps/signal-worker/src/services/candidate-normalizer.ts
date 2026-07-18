import type { CandidateSignal } from "@zxlab/signal-schema";
import type { RawCollectedItem } from "../collectors/types";
import type { SignalSourceConfig } from "../config/sources";
import { SignalError } from "../lib/errors";
import { decodeXml } from "../collectors/xml";

const TRACKING_PARAMETERS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"]);

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function plainText(value: string, maxLength: number): string {
  const withParagraphs = value.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])\s*>/gi, "\n");
  const stripped = decodeXml(withParagraphs.replace(/<[^>]+>/g, " "));
  return normalizeWhitespace(stripped).slice(0, maxLength);
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SignalError("NORMALIZATION_FAILED", "Candidate URL must use HTTP or HTTPS", 400);
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function timestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizeCandidate(
  source: SignalSourceConfig,
  raw: RawCollectedItem,
  context: { runId: string; now: string },
): Promise<CandidateSignal> {
  try {
    const title = plainText(raw.title, 240);
    const summary = raw.summary ? plainText(raw.summary, 4_000) : undefined;
    const contentText = raw.contentText ? plainText(raw.contentText, 12_000) : undefined;
    if (!title || !raw.externalId.trim()) throw new Error("Missing stable ID or title");
    const canonicalUrl = canonicalizeUrl(raw.url);
    const stableHash = await sha256(`${source.id}\n${raw.externalId.trim()}`);
    const contentHash = await sha256(`${title.toLowerCase()}\n${summary?.toLowerCase() ?? ""}\n${canonicalUrl}`);
    const textSample = `${title} ${summary ?? ""}`;
    return {
      id: `candidate_${stableHash.slice(0, 32)}`,
      source: { sourceId: source.id, sourceName: source.name, sourceType: source.type, externalId: raw.externalId.trim() },
      categoryHint: source.categoryHint,
      title,
      url: raw.url,
      canonicalUrl,
      summary: summary || undefined,
      contentText: contentText || undefined,
      author: raw.authorName || raw.authorUrl ? {
        name: raw.authorName ? plainText(raw.authorName, 200) : undefined,
        url: raw.authorUrl ? canonicalizeUrl(raw.authorUrl) : undefined,
      } : undefined,
      publishedAt: timestamp(raw.publishedAt),
      updatedAt: timestamp(raw.updatedAt),
      fetchedAt: new Date(context.now).toISOString(),
      tags: [...new Set(source.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
      language: /[\u3400-\u9fff]/.test(textSample) ? "zh" : "en",
      contentHash,
      metadata: raw.metadata ?? {},
      collectionRunId: context.runId,
      status: "new",
    };
  } catch (cause) {
    if (cause instanceof SignalError) throw cause;
    throw new SignalError("NORMALIZATION_FAILED", "Candidate normalization failed", 400, cause);
  }
}

export function fixtureCandidate(
  value: { id: string; category: "ai-engineering" | "markets" | "zxlab"; title: string; summary: string; url: string; publisher: string; publishedAt?: string; testMaterial?: boolean },
  runId = "fixture",
): CandidateSignal {
  const now = new Date().toISOString();
  return {
    id: value.id,
    source: { sourceId: "fixture", sourceName: value.publisher, sourceType: "manual", externalId: value.id },
    categoryHint: value.category,
    title: value.title,
    url: value.url,
    canonicalUrl: canonicalizeUrl(value.url),
    summary: value.summary,
    publishedAt: timestamp(value.publishedAt),
    fetchedAt: now,
    tags: ["fixture"],
    language: /[\u3400-\u9fff]/.test(`${value.title} ${value.summary}`) ? "zh" : "en",
    contentHash: `fixture:${value.id}`,
    metadata: { testMaterial: value.testMaterial === true },
    collectionRunId: runId,
    status: "eligible",
  };
}
