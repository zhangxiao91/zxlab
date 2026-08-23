import type { CandidateSignal, SignalSourceType } from "@zxlab/signal-schema";
import { findSource, type SignalDeliveryMode } from "../config/sources";

const RELEASE_NOTE_SOURCE_TYPES = new Set<SignalSourceType>(["github-release", "web-changelog"]);
export const SIGNAL_SOURCE_POLICY_VERSION = "signal-sources-v2";

export type SignalSourcePolicyReason =
  | "DAILY_SOURCE"
  | "NON_DAILY_SOURCE"
  | "WEEKLY_ROUTINE_UPDATE"
  | "MATERIAL_BREAKING_CHANGE"
  | "MATERIAL_SECURITY_CHANGE"
  | "MATERIAL_PRICING_CHANGE"
  | "MATERIAL_QUOTA_REDUCTION"
  | "MATERIAL_AVAILABILITY_REGRESSION";

export interface SignalSourceClassification {
  family: string;
  releaseNote: boolean;
  dailyEligible: boolean;
  dailyCandidateQuota: number;
  dailyEditionQuota: number;
  deliveryMode: SignalDeliveryMode;
  reasonCode: SignalSourcePolicyReason;
}

export interface SignalSourcePolicy {
  classify(candidate: CandidateSignal): SignalSourceClassification;
  familyFor(candidate: CandidateSignal): string;
  isReleaseNote(candidate: CandidateSignal): boolean;
  releaseNoteLimit(itemCount: number): number;
}

function materiality(candidate: CandidateSignal): SignalSourcePolicyReason | undefined {
  const text = [candidate.title, candidate.summary, candidate.contentText, ...candidate.tags]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC")
    .toLowerCase();
  const negatedBreaking = /\b(?:no|without)\s+(?:new\s+)?breaking changes?\b/.test(text);
  if (!negatedBreaking && /\b(breaking|incompatible|deprecat(?:e|ed|ion)|sunset|end[ -]of[ -]life|eol|remov(?:e|ed|al))\b/.test(text)) {
    return "MATERIAL_BREAKING_CHANGE";
  }
  const securityDocumentation = /\bsecurity\s+(?:documentation|docs?|guide|guidance)\b|\b(?:documentation|docs?)\s+(?:for|about|on)\s+security\b/.test(text);
  if (/\b(cve-\d{4}-\d+|vulnerabilit(?:y|ies))\b/.test(text)
    || (!securityDocumentation && /\bsecurity\b/.test(text))) return "MATERIAL_SECURITY_CHANGE";
  const unchangedPricing = /\b(?:pricing|billing)\s+(?:remains?|is|are|stays?)\s+unchanged\b/.test(text);
  if (!unchangedPricing && /\b(pricing|billing)\b/.test(text)) return "MATERIAL_PRICING_CHANGE";
  const negatedQuotaReduction = /\b(?:quota|limit)\b.{0,24}\b(?:not|never)\s+(?:been\s+)?reduc(?:e|ed)\b|\bno\s+(?:quota|limit)\s+reduction\b/.test(text);
  if (!negatedQuotaReduction && /\b(quota|limit)\b.{0,40}\b(reduc(?:e|ed|tion)|lower(?:ed|ing)?|cut|decreas(?:e|ed))\b|\b(reduc(?:e|ed|tion)|lower(?:ed|ing)?|cut|decreas(?:e|ed))\b.{0,40}\b(quota|limit)\b/.test(text)) {
    return "MATERIAL_QUOTA_REDUCTION";
  }
  if (/\b(outage|availability regression|service disruption|regional unavailability)\b/.test(text)) {
    return "MATERIAL_AVAILABILITY_REGRESSION";
  }
  return undefined;
}

/**
 * Keeps vendor-family and routine-release classification auditable and shared
 * between preselection, deterministic generation, and the final edition gate.
 */
export const signalSourcePolicy: SignalSourcePolicy = {
  classify(candidate) {
    const configured = findSource(candidate.source.sourceId);
    const family = configured?.family || candidate.source.sourceId;
    const sourceType = configured?.type ?? candidate.source.sourceType;
    const deliveryMode = configured?.deliveryMode ?? "daily";
    const materialReason = configured?.materialityPolicy === "cloudflare-material-change"
      ? materiality(candidate)
      : undefined;
    const dailyEligible = materialReason !== undefined || deliveryMode === "daily";
    return {
      family,
      releaseNote: (RELEASE_NOTE_SOURCE_TYPES.has(sourceType)
        || candidate.source.sourceId === "cloudflare-developer-platform")
        && materialReason === undefined,
      dailyEligible,
      dailyCandidateQuota: configured?.dailyCandidateQuota ?? 3,
      dailyEditionQuota: configured?.dailyEditionQuota ?? 12,
      deliveryMode,
      reasonCode: materialReason
        ?? (deliveryMode === "weekly" ? "WEEKLY_ROUTINE_UPDATE" : dailyEligible ? "DAILY_SOURCE" : "NON_DAILY_SOURCE"),
    };
  },

  familyFor(candidate) {
    return this.classify(candidate).family;
  },

  isReleaseNote(candidate) {
    return this.classify(candidate).releaseNote;
  },

  releaseNoteLimit(itemCount) {
    return Math.min(2, Math.floor(Math.max(0, itemCount) / 3));
  },
};
