import assert from "node:assert/strict";
import test from "node:test";
import { narrateWithRepair, type Narrator } from "./narration.ts";
import type { MarketAgentCommand, SealedEvidenceBundle } from "@zxlab/market-agent-schema";

const command: MarketAgentCommand = { profileId: "p1", trigger: "manual", workflow: "close_review", idempotencyKey: "narration-test-1" };
const evidence: SealedEvidenceBundle = { schemaVersion: "market-agent.v1", eventRuleVersion: "market-event.v1", profileId: "p1", workflow: "close_review", watchlistRevision: "w1", instrumentIds: ["SSE:600000"], items: [{ id: "fact-1", kind: "market_fact", origin: "server-observed", value: { price: 12 }, reliable: true }], contextUses: [], fingerprint: "sha256:test", sealedAt: "2026-08-05T00:00:00.000Z" };

test("invalid model output is repaired once then accepted", async () => {
  let calls = 0;
  const narrator: Narrator = { async narrate() { calls += 1; return { status: "success", headline: "bad", summary: "bad", observations: [{ id: "x", class: "fact", importance: "high", title: "x", explanation: "x", evidenceIds: ["missing"] }], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint }; } };
  const valid = { status: "success", headline: "ok", summary: "ok", observations: [{ id: "x", class: "fact", importance: "high", title: "x", explanation: "x", evidenceIds: ["fact-1"] }], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint };
  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence, repair: async () => valid });
  assert.equal(result.repaired, true); assert.equal(result.result.headline, "ok"); assert.equal(calls, 1);
});

test("forbidden trade instruction falls back deterministically", async () => {
  const narrator: Narrator = { async narrate() { return { status: "success", headline: "买入", summary: "buy now", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint }; } };
  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence });
  assert.equal(result.result.status, "partial"); assert.match(result.result.limitations.at(-1) ?? "", /降级/);
});

test("a failed repair falls back without starting another generation", async () => {
  let generations = 0;
  let repairs = 0;
  const narrator: Narrator = {
    async narrate() {
      generations += 1;
      return { status: "success", headline: "bad", summary: "bad", observations: [{ id: "x", class: "fact", importance: "high", title: "x", explanation: "x", evidenceIds: ["missing"] }], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint };
    },
    async repair() {
      repairs += 1;
      throw new Error("gateway timeout");
    },
  };

  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence });

  assert.equal(generations, 1);
  assert.equal(repairs, 1);
  assert.equal(result.result.status, "partial");
  assert.match(result.issues.join("\n"), /repair unavailable/);
});
