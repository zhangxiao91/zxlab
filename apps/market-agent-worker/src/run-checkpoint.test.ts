import assert from "node:assert/strict";
import test from "node:test";
import { COMPANY_FINANCIAL_UPDATE_TOOL, FINANCIAL_TOOL_POLICY_VERSION, type FinancialToolSessionReceipt, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { marketSnapshotFixture } from "@zxlab/market-schema/fixtures";
import { calculateResearchFactBundleFingerprint } from "@zxlab/research-fact-schema";
import { researchFactBundleFixture } from "@zxlab/research-fact-schema/fixtures";
import { checkpointSnapshotPayload, createRunCheckpoint, parseCheckpointSnapshotPayload, verifyRunCheckpoint } from "./run-checkpoint.ts";

test("run-checkpoint.v3 seals a financial tool receipt and Research Bundle together", async () => {
  const snapshot = marketSnapshotFixture();
  const research = researchFactBundleFixture();
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);
  const evidence = evidenceFixture();
  const toolSession: FinancialToolSessionReceipt = {
    policyVersion: FINANCIAL_TOOL_POLICY_VERSION,
    runId: "run-tool-checkpoint",
    status: "completed",
    selectionSource: "model",
    execution: {
      invocationId: "tool-invocation-1",
      tool: COMPANY_FINANCIAL_UPDATE_TOOL,
      attempt: 1,
      outcome: "operational",
      researchFingerprint: research.fingerprint,
      startedAt: "2026-08-23T01:00:00.000Z",
      completedAt: "2026-08-23T01:00:01.000Z",
      durationMs: 1_000,
    },
  };

  const checkpoint = await createRunCheckpoint(snapshot, evidence, research, toolSession);
  const payload = checkpointSnapshotPayload(checkpoint) as { schemaVersion?: string };
  const parsed = parseCheckpointSnapshotPayload(payload);

  assert.equal(payload.schemaVersion, "run-checkpoint.v3");
  assert.deepEqual(parsed.toolSession, toolSession);
  assert.equal(await verifyRunCheckpoint(checkpoint), true);
  assert.equal(await verifyRunCheckpoint({ ...checkpoint, toolSession: { ...toolSession, runId: "tampered" } }), false);
});

test("legacy bare and v2 checkpoint payloads remain readable without tool execution", async () => {
  const snapshot = marketSnapshotFixture();
  const research = researchFactBundleFixture();
  research.fingerprint = await calculateResearchFactBundleFingerprint(research);

  assert.equal(parseCheckpointSnapshotPayload(snapshot).toolSession, undefined);
  assert.equal(parseCheckpointSnapshotPayload({ schemaVersion: "run-checkpoint.v2", snapshot, research }).research?.fingerprint, research.fingerprint);
});

function evidenceFixture(): SealedEvidenceBundle {
  return {
    schemaVersion: "market-agent.v1",
    eventRuleVersion: "market-event.v1",
    profileId: "profile-1",
    workflow: "ask",
    watchlistRevision: "watchlist-1",
    instrumentIds: ["SSE:600000"],
    items: [],
    contextUses: [],
    fingerprint: `sha256:${"b".repeat(64)}`,
    sealedAt: "2026-08-23T01:00:02.000Z",
    ask: { scope: "news_and_announcements", planVersion: "ask-plan.v1" },
  };
}
