import { isDossierBaseReceipt, isFinancialToolSessionReceipt, type DossierBaseReceipt, type FinancialToolSessionReceipt, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { parseMarketSnapshot, type MarketSnapshot } from "@zxlab/market-schema";
import { parseResearchFactBundle, verifyResearchFactBundleFingerprint, type ResearchFactBundle } from "@zxlab/research-fact-schema";

export interface RunCheckpoint {
  snapshot: MarketSnapshot;
  evidence: SealedEvidenceBundle;
  research?: ResearchFactBundle;
  toolSession?: FinancialToolSessionReceipt;
  dossierBase?: DossierBaseReceipt;
  dossierProjectionUnavailable?: DossierProjectionUnavailableReceipt;
  integrityFingerprint: `sha256:${string}`;
}

export interface DossierProjectionUnavailableReceipt {
  status: "unavailable";
  code: "DOSSIER_BASE_UNAVAILABLE";
  retryable: true;
}

export async function createRunCheckpoint(
  snapshot: MarketSnapshot,
  evidence: SealedEvidenceBundle,
  research?: ResearchFactBundle,
  toolSession?: FinancialToolSessionReceipt,
  dossierBase?: DossierBaseReceipt,
  dossierProjectionUnavailable?: DossierProjectionUnavailableReceipt,
): Promise<RunCheckpoint> {
  assertToolSessionResearch(toolSession, research);
  assertDossierProjectionReceipt(dossierBase, dossierProjectionUnavailable, evidence);
  return {
    snapshot,
    evidence,
    ...(research ? { research } : {}),
    ...(toolSession ? { toolSession } : {}),
    ...(dossierBase ? { dossierBase } : {}),
    ...(dossierProjectionUnavailable ? { dossierProjectionUnavailable } : {}),
    integrityFingerprint: await checkpointIntegrityFingerprint(snapshot, evidence, research, toolSession, dossierBase, dossierProjectionUnavailable),
  };
}

export async function verifyRunCheckpoint(checkpoint: RunCheckpoint): Promise<boolean> {
  if (checkpoint.research && !await verifyResearchFactBundleFingerprint(checkpoint.research)) return false;
  try { assertToolSessionResearch(checkpoint.toolSession, checkpoint.research); }
  catch { return false; }
  try { assertDossierProjectionReceipt(checkpoint.dossierBase, checkpoint.dossierProjectionUnavailable, checkpoint.evidence); }
  catch { return false; }
  return checkpoint.integrityFingerprint === await checkpointIntegrityFingerprint(
    checkpoint.snapshot,
    checkpoint.evidence,
    checkpoint.research,
    checkpoint.toolSession,
    checkpoint.dossierBase,
    checkpoint.dossierProjectionUnavailable,
  );
}

export function checkpointSnapshotPayload(checkpoint: RunCheckpoint): unknown {
  if (checkpoint.dossierBase || checkpoint.dossierProjectionUnavailable) return {
    schemaVersion: "run-checkpoint.v4",
    snapshot: checkpoint.snapshot,
    ...(checkpoint.research ? { research: checkpoint.research } : {}),
    ...(checkpoint.toolSession ? { toolSession: checkpoint.toolSession } : {}),
    ...(checkpoint.dossierBase ? { dossierBase: checkpoint.dossierBase } : {}),
    ...(checkpoint.dossierProjectionUnavailable ? { dossierProjectionUnavailable: checkpoint.dossierProjectionUnavailable } : {}),
  };
  if (checkpoint.toolSession) return {
    schemaVersion: "run-checkpoint.v3",
    snapshot: checkpoint.snapshot,
    ...(checkpoint.research ? { research: checkpoint.research } : {}),
    toolSession: checkpoint.toolSession,
  };
  return checkpoint.research
    ? { schemaVersion: "run-checkpoint.v2", snapshot: checkpoint.snapshot, research: checkpoint.research }
    : checkpoint.snapshot;
}

export function parseCheckpointSnapshotPayload(value: unknown): Pick<RunCheckpoint, "snapshot" | "research" | "toolSession" | "dossierBase" | "dossierProjectionUnavailable"> {
  if (isRecord(value) && value.schemaVersion === "run-checkpoint.v4") {
    const research = value.research === undefined ? undefined : parseResearchFactBundle(value.research);
    const toolSession = value.toolSession === undefined ? undefined : value.toolSession;
    if (toolSession !== undefined && !isFinancialToolSessionReceipt(toolSession)) throw new Error("RUN_CHECKPOINT_TOOL_SESSION_INVALID");
    const dossierBase = value.dossierBase;
    const dossierProjectionUnavailable = value.dossierProjectionUnavailable;
    if (dossierBase !== undefined && !isDossierBaseReceipt(dossierBase)) throw new Error("RUN_CHECKPOINT_DOSSIER_BASE_INVALID");
    if (dossierProjectionUnavailable !== undefined && !isDossierProjectionUnavailableReceipt(dossierProjectionUnavailable)) {
      throw new Error("RUN_CHECKPOINT_DOSSIER_UNAVAILABLE_INVALID");
    }
    if ((dossierBase === undefined) === (dossierProjectionUnavailable === undefined)) throw new Error("RUN_CHECKPOINT_DOSSIER_RECEIPT_INVALID");
    assertToolSessionResearch(toolSession, research);
    return {
      snapshot: parseMarketSnapshot(value.snapshot),
      ...(research ? { research } : {}),
      ...(toolSession ? { toolSession } : {}),
      ...(dossierBase ? { dossierBase } : {}),
      ...(dossierProjectionUnavailable ? { dossierProjectionUnavailable } : {}),
    };
  }
  if (isRecord(value) && value.schemaVersion === "run-checkpoint.v3") {
    const research = value.research === undefined ? undefined : parseResearchFactBundle(value.research);
    if (!isFinancialToolSessionReceipt(value.toolSession)) throw new Error("RUN_CHECKPOINT_TOOL_SESSION_INVALID");
    assertToolSessionResearch(value.toolSession, research);
    return { snapshot: parseMarketSnapshot(value.snapshot), ...(research ? { research } : {}), toolSession: value.toolSession };
  }
  if (isRecord(value) && value.schemaVersion === "run-checkpoint.v2") {
    return { snapshot: parseMarketSnapshot(value.snapshot), research: parseResearchFactBundle(value.research) };
  }
  return { snapshot: parseMarketSnapshot(value) };
}

async function checkpointIntegrityFingerprint(
  snapshot: MarketSnapshot,
  evidence: SealedEvidenceBundle,
  research?: ResearchFactBundle,
  toolSession?: FinancialToolSessionReceipt,
  dossierBase?: DossierBaseReceipt,
  dossierProjectionUnavailable?: DossierProjectionUnavailableReceipt,
): Promise<`sha256:${string}`> {
  const canonical = stableJson(dossierBase || dossierProjectionUnavailable
    ? {
      snapshot,
      evidence,
      ...(research ? { research } : {}),
      ...(toolSession ? { toolSession } : {}),
      ...(dossierBase ? { dossierBase } : {}),
      ...(dossierProjectionUnavailable ? { dossierProjectionUnavailable } : {}),
    }
    : toolSession
    ? { snapshot, evidence, ...(research ? { research } : {}), toolSession }
    : research ? { snapshot, evidence, research } : { snapshot, evidence });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function assertDossierProjectionReceipt(
  dossierBase: DossierBaseReceipt | undefined,
  dossierProjectionUnavailable: DossierProjectionUnavailableReceipt | undefined,
  evidence: SealedEvidenceBundle,
): void {
  if (dossierBase && dossierProjectionUnavailable) throw new Error("RUN_CHECKPOINT_DOSSIER_RECEIPT_INVALID");
  if (dossierProjectionUnavailable && !isDossierProjectionUnavailableReceipt(dossierProjectionUnavailable)) {
    throw new Error("RUN_CHECKPOINT_DOSSIER_UNAVAILABLE_INVALID");
  }
  if (!dossierBase) return;
  if (!isDossierBaseReceipt(dossierBase)
    || dossierBase.profileId !== evidence.profileId
    || !evidence.instrumentIds.includes(dossierBase.instrumentId)) throw new Error("RUN_CHECKPOINT_DOSSIER_BASE_INVALID");
}

function isDossierProjectionUnavailableReceipt(value: unknown): value is DossierProjectionUnavailableReceipt {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3
    && keys[0] === "code"
    && keys[1] === "retryable"
    && keys[2] === "status"
    && value.status === "unavailable"
    && value.code === "DOSSIER_BASE_UNAVAILABLE"
    && value.retryable === true;
}

function assertToolSessionResearch(toolSession: FinancialToolSessionReceipt | undefined, research: ResearchFactBundle | undefined): void {
  if (!toolSession) return;
  if (!isFinancialToolSessionReceipt(toolSession)) throw new Error("RUN_CHECKPOINT_TOOL_SESSION_INVALID");
  if (toolSession.status === "completed") {
    if (!research || toolSession.execution.researchFingerprint !== research.fingerprint) throw new Error("RUN_CHECKPOINT_TOOL_RESEARCH_MISMATCH");
  } else if (research) throw new Error("RUN_CHECKPOINT_SKIPPED_TOOL_HAS_RESEARCH");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
