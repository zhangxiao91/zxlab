export type BriefingCategory = "ai-engineering" | "markets" | "zxlab";

export type BriefingStatus = "generating" | "ready" | "partial" | "failed";

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
  stats: {
    fetched: number;
    deduplicated: number;
    selected: number;
  };
  items: BriefingItem[];
}

export type MemoryScope = "discussion" | "project" | "preference" | "belief";

export type AnnotationAction =
  | "comment"
  | "explain"
  | "challenge"
  | "remember"
  | "track";

export interface Annotation {
  id: string;
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
  content: string;
  confidence: number;
  status: "proposed" | "accepted" | "rejected";
}

export interface AnnotationInput {
  briefingItemId: string;
  selectedText: string;
  comment: string;
  action: AnnotationAction;
}

export interface AnnotationResponse {
  reply: AnnotationReply;
  memoryCandidate: MemoryCandidate;
}

export type BriefingPreviewState = BriefingStatus | "empty";
