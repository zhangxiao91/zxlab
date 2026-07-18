export const memoryNamespaces = ["global", "briefing", "markets", "coding", "zxlab"] as const;
export const memoryKinds = ["preference", "fact", "decision", "summary"] as const;
export const memoryStatuses = ["active", "superseded", "forgotten"] as const;
export const feedbackActions = ["like", "dislike", "save", "dismiss", "comment"] as const;

export type MemoryNamespace = typeof memoryNamespaces[number];
export type MemoryKind = typeof memoryKinds[number];
export type MemoryItemStatus = typeof memoryStatuses[number];
export type FeedbackAction = typeof feedbackActions[number];

export interface MemoryItem {
  id: string;
  namespace: MemoryNamespace;
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  sourceType: string;
  sourceId?: string;
  status: MemoryItemStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface FeedbackEvent {
  id: string;
  targetType: string;
  targetId: string;
  action: FeedbackAction;
  comment?: string;
  createdAt: string;
}

export interface MemoryRevision {
  id: string;
  memoryId: string;
  oldContent: string;
  newContent: string;
  reason: string;
  createdAt: string;
}

export interface ConsolidationCandidate {
  id: string;
  action: "create" | "update" | "ignore";
  reason: string;
  memoryId?: string;
  memory?: Partial<Pick<MemoryItem, "namespace" | "kind" | "content" | "importance" | "confidence">>;
  sourceEventIds: string[];
  status: "proposed" | "accepted" | "rejected";
  createdAt: string;
  resolvedAt?: string;
}

export interface RetrieveMemoryInput {
  task: string;
  namespaces: MemoryNamespace[];
  query: string;
  limit: number;
  tokenBudget: number;
}

export interface RetrieveMemoryResult {
  memories: MemoryItem[];
  summary: string;
  tokenEstimate: number;
}
