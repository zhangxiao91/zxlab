import {
  createMockAnnotationResponse,
  createMockBriefing,
  updateMockMemoryCandidate,
} from "./mock";
import type {
  Annotation,
  AnnotationInput,
  AnnotationResponse,
  BriefingPreviewState,
  DailyBriefing,
  MemoryCandidate,
  MemoryScope,
} from "./types";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export async function getLatestBriefing(
  state: BriefingPreviewState = "ready",
): Promise<DailyBriefing> {
  return createMockBriefing(state);
}

export async function createAnnotation(input: AnnotationInput): Promise<Annotation> {
  return {
    ...input,
    id: `annotation-${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
}

export async function requestAnnotationReply(
  annotation: Annotation,
): Promise<AnnotationResponse> {
  await wait(720);
  return createMockAnnotationResponse(annotation);
}

export async function updateMemoryCandidate(
  candidate: MemoryCandidate,
  action: "accept" | "reject",
  scope?: MemoryScope,
): Promise<MemoryCandidate> {
  await wait(260);
  return updateMockMemoryCandidate(candidate, action, scope);
}

// Future adapter routes:
// GET  /api/briefings/latest
// GET  /api/briefings/:date
// POST /api/annotations
// POST /api/annotations/:id/reply
// POST /api/memory-candidates/:id/accept
// POST /api/memory-candidates/:id/reject
