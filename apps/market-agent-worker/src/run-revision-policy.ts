import { isRetryableRunStatus, type RunStatus, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { isMarketReference } from "@zxlab/market-schema";

export function canCreateRunRevision(status: RunStatus, evidence: SealedEvidenceBundle | null): boolean {
  if (isRetryableRunStatus(status)) return true;
  if (status !== "success" && status !== "partial") return false;
  return !hasMarketReference(evidence);
}

function hasMarketReference(evidence: SealedEvidenceBundle | null): boolean {
  return Boolean(evidence?.items.some((item) => {
    const value = record(item.value);
    return value?.type === "snapshot_context"
      && isMarketReference(value.reference);
  }));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
