import { validateSealedEvidence, type AskScope } from "@zxlab/market-agent-schema";
import { validateMarketSnapshot, type MarketSnapshot } from "@zxlab/market-schema";
import { verifyRunCheckpoint, type RunCheckpoint } from "./run-checkpoint.ts";
import { diffMarketSnapshots } from "./snapshot-diff.ts";

export interface FrozenRunReplayInput {
  checkpoint: RunCheckpoint;
  previous?: MarketSnapshot;
  expected: {
    profileId: string;
    workflow: string;
    evidenceFingerprint: string;
    askScope?: AskScope;
  };
}

export interface FrozenRunReplayResult {
  ok: boolean;
  issues: string[];
}

export async function evaluateFrozenRun(input: FrozenRunReplayInput): Promise<FrozenRunReplayResult> {
  const issues: string[] = [];
  if (!validateMarketSnapshot(input.checkpoint.snapshot).ok) issues.push("MARKET_SNAPSHOT_INVALID");
  if (validateSealedEvidence(input.checkpoint.evidence).length) issues.push("EVIDENCE_INVALID");
  if (input.checkpoint.evidence.profileId !== input.expected.profileId) issues.push("PROFILE_SCOPE_MISMATCH");
  if (input.checkpoint.evidence.workflow !== input.expected.workflow) issues.push("WORKFLOW_SCOPE_MISMATCH");
  if (input.expected.askScope !== undefined && input.checkpoint.evidence.ask?.scope !== input.expected.askScope) issues.push("ASK_SCOPE_MISMATCH");
  if (input.checkpoint.evidence.fingerprint !== input.expected.evidenceFingerprint) issues.push("EVIDENCE_FINGERPRINT_MISMATCH");
  if (!await verifyRunCheckpoint(input.checkpoint)) issues.push("CHECKPOINT_INTEGRITY_MISMATCH");
  if (!sameValues(input.checkpoint.evidence.instrumentIds, input.checkpoint.snapshot.request.instrumentIds)) issues.push("INSTRUMENT_SCOPE_MISMATCH");
  const stored = input.checkpoint.evidence.items.find((item) => item.kind === "snapshot_diff")?.value;
  if (stored && !input.previous) issues.push("PREVIOUS_SNAPSHOT_REQUIRED");
  if (input.previous) {
    const expected = diffMarketSnapshots(input.previous, input.checkpoint.snapshot);
    if (stableJson(stored) !== stableJson(expected)) issues.push("SNAPSHOT_DIFF_MISMATCH");
  }
  return { ok: issues.length === 0, issues };
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
