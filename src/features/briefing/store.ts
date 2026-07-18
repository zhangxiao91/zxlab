import type { Annotation, AnnotationReply, MemoryCandidate } from "./types";

export interface BriefingSession {
  annotations: Annotation[];
  replies: AnnotationReply[];
  memoryCandidates: MemoryCandidate[];
}

const storageKey = "zx-signal-session-v1";
const emptySession = (): BriefingSession => ({
  annotations: [],
  replies: [],
  memoryCandidates: [],
});

export const briefingSessionStore = {
  load(): BriefingSession {
    try {
      const value = window.localStorage.getItem(storageKey);
      return value ? (JSON.parse(value) as BriefingSession) : emptySession();
    } catch {
      return emptySession();
    }
  },

  save(session: BriefingSession): void {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(session));
    } catch {
      // The current page still works when storage is unavailable.
    }
  },
};
