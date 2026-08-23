import type { AnnotationAction } from "./types";

const storageKey = "zxlab:pending-signal-annotation";
const actions = new Set<AnnotationAction>(["comment", "explain", "challenge", "remember", "track"]);

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingAnnotation {
  idempotencyKey: string;
  briefingId: string;
  briefingItemId: string;
  itemTitle: string;
  selectedText: string;
  comment: string;
  action: AnnotationAction;
}

export type PendingAnnotationDraft = Omit<PendingAnnotation, "idempotencyKey">;

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPendingAnnotation(value: unknown): value is PendingAnnotation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Partial<PendingAnnotation>;
  return typeof draft.idempotencyKey === "string" && idempotencyKeyPattern.test(draft.idempotencyKey)
    && typeof draft.briefingId === "string" && draft.briefingId.length > 0
    && typeof draft.briefingItemId === "string" && draft.briefingItemId.length > 0
    && typeof draft.itemTitle === "string"
    && typeof draft.selectedText === "string" && draft.selectedText.length > 0
    && typeof draft.comment === "string" && draft.comment.length > 0
    && typeof draft.action === "string" && actions.has(draft.action as AnnotationAction);
}

function sameRequest(left: PendingAnnotation, right: PendingAnnotationDraft): boolean {
  return left.briefingId === right.briefingId
    && left.briefingItemId === right.briefingItemId
    && left.selectedText === right.selectedText
    && left.comment === right.comment
    && left.action === right.action;
}

export function reservePendingAnnotation(
  storage: SessionStorageLike,
  draft: PendingAnnotationDraft,
  createId: () => string = () => crypto.randomUUID(),
): PendingAnnotation {
  const current = loadPendingAnnotation(storage);
  if (current && sameRequest(current, draft)) return current;
  const pending = { ...draft, idempotencyKey: createId() };
  if (!idempotencyKeyPattern.test(pending.idempotencyKey)) throw new Error("Pending annotation idempotency key must be a UUID");
  savePendingAnnotation(storage, pending);
  return pending;
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
