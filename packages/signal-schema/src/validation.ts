import type {
  AnnotationInput,
  AnnotationReplyDraft,
  CandidateEditorialDecision,
  CandidateSignal,
  EditorialDecisionDraft,
  GenerateBriefingRequest,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
  ResolveMemoryCandidateRequest,
  StartCollectionRequest,
} from "./types";

export class SignalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignalValidationError";
  }
}

type JsonRecord = Record<string, unknown>;
const categories = ["ai-engineering", "markets", "zxlab"] as const;
const signalCategories = ["ai-engineering", "markets", "zxlab", "uncategorized"] as const;
const sourceTypes = ["rss", "github-release", "hacker-news", "arxiv", "manual"] as const;
const candidateStatuses = ["new", "duplicate", "eligible", "filtered", "selected", "archived"] as const;
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
  const source = record(input.source, "candidate.source");
  const author = input.author === undefined ? undefined : record(input.author, "candidate.author");
  if (!Array.isArray(input.tags) || input.tags.length > 30) throw new SignalValidationError("candidate.tags must be an array");
  const metadata = input.metadata === undefined ? {} : record(input.metadata, "candidate.metadata");
  return {
    id: string(input.id, "candidate.id", 120),
    source: {
      sourceId: string(source.sourceId, "candidate.source.sourceId", 120),
      sourceName: string(source.sourceName, "candidate.source.sourceName", 200),
      sourceType: oneOf(source.sourceType, sourceTypes, "candidate.source.sourceType"),
      externalId: string(source.externalId, "candidate.source.externalId", 240),
    },
    categoryHint: oneOf(input.categoryHint, signalCategories, "candidate.categoryHint"),
    title: string(input.title, "candidate.title", 240),
    url: absoluteUrl(input.url, "candidate.url"),
    canonicalUrl: absoluteUrl(input.canonicalUrl, "candidate.canonicalUrl"),
    summary: optionalString(input.summary, "candidate.summary", 4_000),
    contentText: optionalString(input.contentText, "candidate.contentText", 12_000),
    author: author ? {
      name: optionalString(author.name, "candidate.author.name", 200),
      url: author.url === undefined ? undefined : absoluteUrl(author.url, "candidate.author.url"),
    } : undefined,
    publishedAt: input.publishedAt === undefined ? undefined : isoTimestamp(input.publishedAt, "candidate.publishedAt"),
    updatedAt: input.updatedAt === undefined ? undefined : isoTimestamp(input.updatedAt, "candidate.updatedAt"),
    fetchedAt: isoTimestamp(input.fetchedAt, "candidate.fetchedAt"),
    tags: [...new Set(input.tags.map((tag, index) => string(tag, `candidate.tags[${index}]`, 80)))],
    language: optionalString(input.language, "candidate.language", 24),
    contentHash: string(input.contentHash, "candidate.contentHash", 128),
    metadata,
    collectionRunId: string(input.collectionRunId, "candidate.collectionRunId", 120),
    status: oneOf(input.status, candidateStatuses, "candidate.status"),
    duplicateOf: optionalString(input.duplicateOf, "candidate.duplicateOf", 120),
    dedupReason: input.dedupReason === undefined ? undefined : oneOf(input.dedupReason, ["canonical-url", "content-hash"] as const, "candidate.dedupReason"),
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
    candidateMode: input.candidateMode === undefined
      ? input.useFixture === true ? "fixture" : undefined
      : oneOf(input.candidateMode, ["fixture", "collection-run", "time-window"] as const, "candidateMode"),
    collectionRunId: optionalString(input.collectionRunId, "collectionRunId", 120),
    since: input.since === undefined ? undefined : isoTimestamp(input.since, "since"),
    until: input.until === undefined ? undefined : isoTimestamp(input.until, "until"),
    category: input.category === undefined ? undefined : oneOf(input.category, signalCategories, "category"),
    maxCandidates: input.maxCandidates === undefined ? undefined : number(input.maxCandidates, "maxCandidates", 1, 40),
    candidates,
    useFixture: input.useFixture === true,
  };
}

export function parseStartCollectionRequest(value: unknown): StartCollectionRequest {
  const input = record(value, "request");
  const sourceIds = input.sourceIds === undefined ? undefined : (() => {
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 30) throw new SignalValidationError("sourceIds must be an array");
    return [...new Set(input.sourceIds.map((id, index) => string(id, `sourceIds[${index}]`, 120)))];
  })();
  const requestedTypes = input.sourceTypes === undefined ? undefined : (() => {
    if (!Array.isArray(input.sourceTypes) || input.sourceTypes.length > sourceTypes.length) throw new SignalValidationError("sourceTypes must be an array");
    return [...new Set(input.sourceTypes.map((type) => oneOf(type, sourceTypes, "sourceTypes")))];
  })();
  return {
    sourceIds,
    sourceTypes: requestedTypes,
    since: input.since === undefined ? undefined : isoTimestamp(input.since, "since"),
    dryRun: input.dryRun === true,
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

export function parseEditorialDecisionDraft(
  value: unknown,
  allowedCandidateIds: ReadonlySet<string>,
  allowedMemoryIds: ReadonlySet<string>,
): EditorialDecisionDraft {
  const input = record(value, "editorial decisions");
  if (!Array.isArray(input.decisions) || input.decisions.length > 40) throw new SignalValidationError("decisions must be an array");
  const decisions: CandidateEditorialDecision[] = input.decisions.map((raw, index) => {
    const decision = record(raw, `decisions[${index}]`);
    const candidateId = string(decision.candidateId, `decisions[${index}].candidateId`, 120);
    if (!allowedCandidateIds.has(candidateId)) throw new SignalValidationError(`decisions[${index}] references an unknown candidate`);
    if (!Array.isArray(decision.relatedMemoryIds)) throw new SignalValidationError(`decisions[${index}].relatedMemoryIds must be an array`);
    const relatedMemoryIds = decision.relatedMemoryIds.map((id, memoryIndex) => string(id, `decisions[${index}].relatedMemoryIds[${memoryIndex}]`, 120));
    if (relatedMemoryIds.some((id) => !allowedMemoryIds.has(id))) throw new SignalValidationError(`decisions[${index}] references an unknown memory`);
    const mergeTargetCandidateId = optionalString(decision.mergeTargetCandidateId, `decisions[${index}].mergeTargetCandidateId`, 120);
    if (mergeTargetCandidateId && !allowedCandidateIds.has(mergeTargetCandidateId)) throw new SignalValidationError(`decisions[${index}] has an unknown merge target`);
    return {
      candidateId,
      decision: oneOf(decision.decision, ["keep", "drop", "merge"] as const, `decisions[${index}].decision`),
      category: oneOf(decision.category, signalCategories, `decisions[${index}].category`),
      relevance: number(decision.relevance, `decisions[${index}].relevance`, 0, 100),
      novelty: number(decision.novelty, `decisions[${index}].novelty`, 0, 100),
      actionability: number(decision.actionability, `decisions[${index}].actionability`, 0, 100),
      sourceQuality: number(decision.sourceQuality, `decisions[${index}].sourceQuality`, 0, 100),
      reason: string(decision.reason, `decisions[${index}].reason`, 1_000),
      relatedMemoryIds: [...new Set(relatedMemoryIds)],
      mergeTargetCandidateId,
    };
  });
  if (new Set(decisions.map((decision) => decision.candidateId)).size !== decisions.length) throw new SignalValidationError("candidate decisions must be unique");
  return { decisions };
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
