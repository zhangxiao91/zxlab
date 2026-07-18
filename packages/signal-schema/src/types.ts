export type BriefingCategory = "ai-engineering" | "markets" | "zxlab";
export type SignalCategory = BriefingCategory | "uncategorized";
export type SignalSourceType = "rss" | "github-release" | "hacker-news" | "arxiv" | "manual";
export type CandidateStatus = "new" | "duplicate" | "eligible" | "filtered" | "selected" | "archived";
export type BriefingStatus = "generating" | "ready" | "partial" | "failed";
export type BriefingDataOrigin = "mock" | "fixture" | "real";

export interface BriefingSource {
  id: string;
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
}

export interface BriefingItem {
  id: string;
  category: BriefingCategory;
  title: string;
  summary: string;
  whatChanged?: string;
  whyItMatters: string;
  suggestedAction?: string;
  importance: number;
  confidence: number;
  sources: BriefingSource[];
}

export interface DailyBriefing {
  id: string;
  date: string;
  status: BriefingStatus;
  title: string;
  summary: string;
  generatedAt: string;
  promptVersion: string;
  model?: string;
  dataOrigin: BriefingDataOrigin;
  stats: {
    fetched: number;
    deduplicated: number;
    selected: number;
  };
  items: BriefingItem[];
}

export type MemoryScope = "discussion" | "project" | "preference" | "belief";
export type MemoryStatus = "active" | "revoked" | "expired";
export type MemoryCandidateStatus = "proposed" | "accepted" | "rejected";

export type AnnotationAction = "comment" | "explain" | "challenge" | "remember" | "track";

export interface Annotation {
  id: string;
  briefingId: string;
  briefingItemId: string;
  selectedText: string;
  comment: string;
  createdAt: string;
  action: AnnotationAction;
}

export interface AnnotationReply {
  id: string;
  annotationId: string;
  content: string;
  createdAt: string;
  model?: string;
}

export interface MemoryCandidate {
  id: string;
  annotationId: string;
  scope: MemoryScope;
  scopeKey?: string;
  content: string;
  confidence: number;
  reason: string;
  status: MemoryCandidateStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  scopeKey?: string;
  content: string;
  confidence: number;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
  expiresAt?: string;
}

export interface CandidateAuthor {
  name?: string;
  url?: string;
}

export interface CandidateSourceRef {
  sourceId: string;
  sourceName: string;
  sourceType: SignalSourceType;
  externalId: string;
}

export interface CandidateSignal {
  id: string;
  source: CandidateSourceRef;
  categoryHint: SignalCategory;
  title: string;
  url: string;
  canonicalUrl: string;
  summary?: string;
  contentText?: string;
  author?: CandidateAuthor;
  publishedAt?: string;
  updatedAt?: string;
  fetchedAt: string;
  tags: string[];
  language?: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  collectionRunId: string;
  status: CandidateStatus;
  duplicateOf?: string;
  dedupReason?: "canonical-url" | "content-hash";
}

export interface CandidateEditorialDecision {
  candidateId: string;
  decision: "keep" | "drop" | "merge";
  category: SignalCategory;
  relevance: number;
  novelty: number;
  actionability: number;
  sourceQuality: number;
  reason: string;
  relatedMemoryIds: string[];
  mergeTargetCandidateId?: string;
}

export interface StartCollectionRequest {
  sourceIds?: string[];
  sourceTypes?: SignalSourceType[];
  since?: string;
  dryRun?: boolean;
}

export interface CollectionRunSummary {
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  triggerType: "manual" | "workflow";
  startedAt: string;
  completedAt?: string;
  sourceCount: number;
  successSourceCount: number;
  failedSourceCount: number;
  fetchedCount: number;
  insertedCount: number;
  duplicateCount: number;
  errorSummary?: string;
}

export interface CollectionSourceRunSummary {
  id: string;
  collectionRunId: string;
  sourceId: string;
  sourceName?: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  fetchedCount: number;
  insertedCount: number;
  duplicateCount: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface CollectionRunDetail extends CollectionRunSummary {
  sources: CollectionSourceRunSummary[];
}

export interface CandidateListItem extends Omit<CandidateSignal, "contentText"> {
  editorialDecision?: CandidateEditorialDecision;
}

export interface CandidateListResponse {
  candidates: CandidateListItem[];
  nextCursor?: string;
}

export interface AnnotationInput {
  briefingId: string;
  briefingItemId: string;
  selectedText: string;
  comment: string;
  action: AnnotationAction;
}

export interface AnnotationResponse {
  annotation: Annotation;
  reply: AnnotationReply;
  memoryCandidate?: MemoryCandidate;
}

export interface GenerateBriefingRequest {
  date?: string;
  candidateMode?: "fixture" | "collection-run" | "time-window";
  collectionRunId?: string;
  since?: string;
  until?: string;
  category?: SignalCategory;
  maxCandidates?: number;
  // Legacy development input retained for fixture compatibility.
  candidates?: CandidateSignal[];
  useFixture?: boolean;
}

export interface GenerateBriefingResponse {
  briefing: DailyBriefing;
  runId: string;
}

export interface ResolveMemoryCandidateRequest {
  scope?: MemoryScope;
  scopeKey?: string;
  expiresAt?: string;
}

export interface MemoriesResponse {
  memories: MemoryEntry[];
  candidates: MemoryCandidate[];
}

export type SignalErrorCode =
  | "BRIEFING_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "INVALID_MODEL_OUTPUT"
  | "MODEL_REQUEST_FAILED"
  | "DATABASE_WRITE_FAILED"
  | "MEMORY_CANDIDATE_NOT_FOUND"
  | "MEMORY_ALREADY_RESOLVED"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_DISABLED"
  | "SOURCE_FETCH_FAILED"
  | "SOURCE_TIMEOUT"
  | "INVALID_FEED"
  | "INVALID_SOURCE_RESPONSE"
  | "RATE_LIMITED"
  | "NORMALIZATION_FAILED"
  | "CANDIDATE_PERSIST_FAILED"
  | "COLLECTION_RUN_NOT_FOUND"
  | "NO_ELIGIBLE_CANDIDATES"
  | "PARTIAL_COLLECTION";

export interface SignalErrorResponse {
  error: { code: SignalErrorCode; message: string };
}

export interface GeneratedBriefingDraft {
  title: string;
  summary: string;
  items: Array<{
    category: BriefingCategory;
    title: string;
    summary: string;
    whatChanged?: string;
    whyItMatters: string;
    suggestedAction?: string;
    importance: number;
    confidence: number;
    sourceIds: string[];
  }>;
}

export interface EditorialDecisionDraft {
  decisions: CandidateEditorialDecision[];
}

export interface AnnotationReplyDraft {
  reply: string;
}

export interface MemoryCandidateDraft {
  shouldRemember: boolean;
  scope?: MemoryScope;
  content?: string;
  confidence?: number;
  reason?: string;
}

export type BriefingPreviewState = BriefingStatus | "empty";
