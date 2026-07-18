export type BriefingCategory = "ai-engineering" | "markets" | "zxlab";
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

export interface CandidateSignal {
  id: string;
  category: BriefingCategory;
  title: string;
  summary: string;
  url: string;
  publisher: string;
  publishedAt?: string;
  testMaterial?: boolean;
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
  | "UNAUTHORIZED";

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
