import type { AnnotationAction } from "./types";

const storageKey = "zxlab:pending-signal-annotation";
const actions = new Set<AnnotationAction>(["comment", "explain", "challenge", "remember", "track"]);

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingAnnotation {
  briefingId: string;
  briefingItemId: string;
  itemTitle: string;
  selectedText: string;
  comment: string;
  action: AnnotationAction;
}

function isPendingAnnotation(value: unknown): value is PendingAnnotation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Partial<PendingAnnotation>;
  return typeof draft.briefingId === "string" && draft.briefingId.length > 0
    && typeof draft.briefingItemId === "string" && draft.briefingItemId.length > 0
    && typeof draft.itemTitle === "string"
    && typeof draft.selectedText === "string" && draft.selectedText.length > 0
    && typeof draft.comment === "string" && draft.comment.length > 0
    && typeof draft.action === "string" && actions.has(draft.action as AnnotationAction);
}

export function savePendingAnnotation(storage: SessionStorageLike, draft: PendingAnnotation): void {
  storage.setItem(storageKey, JSON.stringify(draft));
}

export function loadPendingAnnotation(storage: SessionStorageLike): PendingAnnotation | null {
  const raw = storage.getItem(storageKey);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return isPendingAnnotation(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearPendingAnnotation(storage: SessionStorageLike): void {
  storage.removeItem(storageKey);
}
