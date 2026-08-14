import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";

export interface RunCheckpoint {
  snapshot: MarketSnapshot;
  evidence: SealedEvidenceBundle;
  integrityFingerprint: `sha256:${string}`;
}

export async function createRunCheckpoint(snapshot: MarketSnapshot, evidence: SealedEvidenceBundle): Promise<RunCheckpoint> {
  return { snapshot, evidence, integrityFingerprint: await checkpointIntegrityFingerprint(snapshot, evidence) };
}

export async function verifyRunCheckpoint(checkpoint: RunCheckpoint): Promise<boolean> {
  return checkpoint.integrityFingerprint === await checkpointIntegrityFingerprint(checkpoint.snapshot, checkpoint.evidence);
}

async function checkpointIntegrityFingerprint(snapshot: MarketSnapshot, evidence: SealedEvidenceBundle): Promise<`sha256:${string}`> {
  const canonical = stableJson({ snapshot, evidence });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
