import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { parseMarketSnapshot, type MarketSnapshot } from "@zxlab/market-schema";
import { parseResearchFactBundle, verifyResearchFactBundleFingerprint, type ResearchFactBundle } from "@zxlab/research-fact-schema";

export interface RunCheckpoint {
  snapshot: MarketSnapshot;
  evidence: SealedEvidenceBundle;
  research?: ResearchFactBundle;
  integrityFingerprint: `sha256:${string}`;
}

export async function createRunCheckpoint(snapshot: MarketSnapshot, evidence: SealedEvidenceBundle, research?: ResearchFactBundle): Promise<RunCheckpoint> {
  return { snapshot, evidence, ...(research ? { research } : {}), integrityFingerprint: await checkpointIntegrityFingerprint(snapshot, evidence, research) };
}

export async function verifyRunCheckpoint(checkpoint: RunCheckpoint): Promise<boolean> {
  if (checkpoint.research && !await verifyResearchFactBundleFingerprint(checkpoint.research)) return false;
  return checkpoint.integrityFingerprint === await checkpointIntegrityFingerprint(checkpoint.snapshot, checkpoint.evidence, checkpoint.research);
}

export function checkpointSnapshotPayload(checkpoint: RunCheckpoint): unknown {
  return checkpoint.research
    ? { schemaVersion: "run-checkpoint.v2", snapshot: checkpoint.snapshot, research: checkpoint.research }
    : checkpoint.snapshot;
}

export function parseCheckpointSnapshotPayload(value: unknown): Pick<RunCheckpoint, "snapshot" | "research"> {
  if (isRecord(value) && value.schemaVersion === "run-checkpoint.v2") {
    return { snapshot: parseMarketSnapshot(value.snapshot), research: parseResearchFactBundle(value.research) };
  }
  return { snapshot: parseMarketSnapshot(value) };
}

async function checkpointIntegrityFingerprint(snapshot: MarketSnapshot, evidence: SealedEvidenceBundle, research?: ResearchFactBundle): Promise<`sha256:${string}`> {
  const canonical = stableJson(research ? { snapshot, evidence, research } : { snapshot, evidence });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
