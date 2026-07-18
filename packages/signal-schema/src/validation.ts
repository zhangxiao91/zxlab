import type {
  AnnotationInput,
  AnnotationReplyDraft,
  CandidateSignal,
  GenerateBriefingRequest,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
  ResolveMemoryCandidateRequest,
} from "./types";

export class SignalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalValidationError";
  }
}

type JsonRecord = Record<string, unknown>;
const categories = ["ai-engineering", "markets", "zxlab"] as const;
const actions = ["comment", "explain", "challenge", "remember", "track"] as const;
const scopes = ["discussion", "project", "preference", "belief"] as const;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SignalValidationError(`${label} must be an object`);
  return value as JsonRecord;
}

function string(value: unknown, label: string, max = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new SignalValidationError(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string, max = 8_000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return string(value, label, max);
}

function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new SignalValidationError(`${label} must be between ${min} and ${max}`);
  return value;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new SignalValidationError(`${label} is invalid`);
  return value as T[number];
}

function isoDate(value: unknown, label: string): string {
  const parsed = string(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || Number.isNaN(Date.parse(`${parsed}T00:00:00Z`))) throw new SignalValidationError(`${label} must be YYYY-MM-DD`);
  return parsed;
}

function isoTimestamp(value: unknown, label: string): string {
  const parsed = string(value, label, 64);
  if (Number.isNaN(Date.parse(parsed))) throw new SignalValidationError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function absoluteUrl(value: unknown, label: string): string {
  const parsed = string(value, label, 2_048);
  let url: URL;
  try { url = new URL(parsed); } catch { throw new SignalValidationError(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SignalValidationError(`${label} must use http or https`);
  return parsed;
}

export function parseCandidateSignal(value: unknown): CandidateSignal {
  const input = record(value, "candidate");
  return {
    id: string(input.id, "candidate.id", 120),
    category: oneOf(input.category, categories, "candidate.category"),
    title: string(input.title, "candidate.title", 240),
    summary: string(input.summary, "candidate.summary", 4_000),
    url: absoluteUrl(input.url, "candidate.url"),
    publisher: string(input.publisher, "candidate.publisher", 160),
    publishedAt: optionalString(input.publishedAt, "candidate.publishedAt", 64),
    testMaterial: input.testMaterial === true,
  };
}

export function parseGenerateBriefingRequest(value: unknown): GenerateBriefingRequest {
  const input = record(value, "request");
  const candidates = input.candidates === undefined ? undefined : (() => {
    if (!Array.isArray(input.candidates) || input.candidates.length > 40) throw new SignalValidationError("candidates must be an array of at most 40 items");
    return input.candidates.map(parseCandidateSignal);
  })();
  return {
    date: input.date === undefined ? undefined : isoDate(input.date, "date"),
    candidates,
    useFixture: input.useFixture === true,
  };
}

export function parseAnnotationInput(value: unknown): AnnotationInput {
  const input = record(value, "request");
  return {
    briefingId: string(input.briefingId, "briefingId", 120),
    briefingItemId: string(input.briefingItemId, "briefingItemId", 120),
    selectedText: string(input.selectedText, "selectedText", 420),
    comment: string(input.comment, "comment", 2_000),
    action: oneOf(input.actionType ?? input.action, actions, "actionType"),
  };
}

export function parseResolveMemoryRequest(value: unknown): ResolveMemoryCandidateRequest {
  const input = record(value, "request");
  return {
    scope: input.scope === undefined ? undefined : oneOf(input.scope, scopes, "scope"),
    scopeKey: optionalString(input.scopeKey, "scopeKey", 120),
    expiresAt: input.expiresAt === undefined ? undefined : isoTimestamp(input.expiresAt, "expiresAt"),
  };
}

export function parseGeneratedBriefingDraft(value: unknown, allowedSourceIds: ReadonlySet<string>): GeneratedBriefingDraft {
  const input = record(value, "briefing");
  if (!Array.isArray(input.items) || input.items.length > 12) throw new SignalValidationError("briefing.items must be an array of at most 12 items");
  const items = input.items.map((raw, index) => {
    const item = record(raw, `items[${index}]`);
    if (!Array.isArray(item.sourceIds) || item.sourceIds.length === 0 || item.sourceIds.length > 8) throw new SignalValidationError(`items[${index}].sourceIds is invalid`);
    const sourceIds = item.sourceIds.map((sourceId, sourceIndex) => string(sourceId, `items[${index}].sourceIds[${sourceIndex}]`, 120));
    if (sourceIds.some((sourceId) => !allowedSourceIds.has(sourceId))) throw new SignalValidationError(`items[${index}] references an unknown source`);
    return {
      category: oneOf(item.category, categories, `items[${index}].category`),
      title: string(item.title, `items[${index}].title`, 240),
      summary: string(item.summary, `items[${index}].summary`, 3_000),
      whatChanged: optionalString(item.whatChanged, `items[${index}].whatChanged`, 2_000),
      whyItMatters: string(item.whyItMatters, `items[${index}].whyItMatters`, 3_000),
      suggestedAction: optionalString(item.suggestedAction, `items[${index}].suggestedAction`, 2_000),
      importance: number(item.importance, `items[${index}].importance`, 0, 100),
      confidence: number(item.confidence, `items[${index}].confidence`, 0, 100),
      sourceIds: [...new Set(sourceIds)],
    };
  });
  return { title: string(input.title, "briefing.title", 240), summary: string(input.summary, "briefing.summary", 4_000), items };
}

export function parseAnnotationReplyDraft(value: unknown): AnnotationReplyDraft {
  const input = record(value, "annotation reply");
  return { reply: string(input.reply, "reply", 4_000) };
}

export function parseMemoryCandidateDraft(value: unknown): MemoryCandidateDraft {
  const input = record(value, "memory candidate");
  if (typeof input.shouldRemember !== "boolean") throw new SignalValidationError("shouldRemember must be boolean");
  if (!input.shouldRemember) return { shouldRemember: false };
  return {
    shouldRemember: true,
    scope: oneOf(input.scope, scopes, "scope"),
    content: string(input.content, "content", 1_000),
    confidence: number(input.confidence, "confidence", 0, 1),
    reason: string(input.reason, "reason", 1_000),
  };
}
