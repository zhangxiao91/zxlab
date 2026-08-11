import type { CandidateSignal, SignalSourceType } from "@zxlab/signal-schema";
import { findSource } from "../config/sources";

const RELEASE_NOTE_SOURCE_TYPES = new Set<SignalSourceType>(["github-release", "web-changelog"]);

export interface SignalSourcePolicy {
  familyFor(candidate: CandidateSignal): string;
  isReleaseNote(candidate: CandidateSignal): boolean;
  releaseNoteLimit(itemCount: number): number;
}

/**
 * Keeps vendor-family and routine-release classification auditable and shared
 * between preselection, deterministic generation, and the final edition gate.
 */
export const signalSourcePolicy: SignalSourcePolicy = {
  familyFor(candidate) {
    const configured = findSource(candidate.source.sourceId);
    return configured?.family || candidate.source.sourceId;
  },

  isReleaseNote(candidate) {
    const configured = findSource(candidate.source.sourceId);
    const sourceType = configured?.type ?? candidate.source.sourceType;
    return RELEASE_NOTE_SOURCE_TYPES.has(sourceType)
      || candidate.source.sourceId === "cloudflare-developer-platform";
  },

  releaseNoteLimit(itemCount) {
    return Math.min(2, Math.floor(Math.max(0, itemCount) / 3));
  },
};
