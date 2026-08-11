import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicNarrator, narrateWithRepair, type Narrator } from "./narration.ts";
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

test("an unreliable quote cannot be promoted to a fact without a limitation", async () => {
  const unreliableEvidence: SealedEvidenceBundle = {
    ...evidence,
    workflow: "ask",
    ask: { scope: "today_change", planVersion: "ask-plan.v1" },
    items: [
      {
        id: "snapshot-context",
        kind: "market_fact",
        origin: "server-observed",
        reliable: false,
        value: {
          type: "snapshot_context",
          quality: { status: "degraded", reliable: false, freshness: "stale", warnings: ["quote stale"], unavailableCapabilities: [] },
          markets: [{ exchange: "SSE", session: "open", open: true, reliable: true, freshness: "fresh" }],
        },
      },
      { id: "stale-quote", kind: "market_fact", origin: "server-observed", reliable: false, value: { type: "quote", instrumentId: "SSE:600000", price: 12, quality: "stale", stale: true } },
    ],
  };
  const narrator: Narrator = {
    async narrate() {
      return {
        status: "success",
        headline: "当前价格上涨",
        summary: "最新价为 12。",
        observations: [{ id: "quote", class: "fact", importance: "high", title: "当前价", explanation: "最新价为 12。", evidenceIds: ["stale-quote"] }],
        portfolioImpacts: [],
        watchNext: [],
        limitations: [],
        evidenceFingerprint: unreliableEvidence.fingerprint,
      };
    },
  };

  const result = await narrateWithRepair(narrator, { workflow: "ask", askScope: "today_change", evidence: unreliableEvidence });

  assert.equal(result.result.status, "partial");
  assert.equal(result.result.observations[0]?.class, "unknown");
  assert.match(result.issues.join("\n"), /unreliable evidence|limitations/i);
});

test("deterministic fallback labels a closed-session quote as last observed, not live", async () => {
  const closedEvidence: SealedEvidenceBundle = {
    ...evidence,
    workflow: "ask",
    ask: { scope: "today_change", planVersion: "ask-plan.v1" },
    items: [
      {
        id: "snapshot-context",
        kind: "market_fact",
        origin: "server-observed",
        reliable: true,
        value: {
          type: "snapshot_context",
          quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], unavailableCapabilities: [] },
          markets: [{ exchange: "SSE", session: "closed", open: false, reliable: true, freshness: "fresh" }],
        },
      },
      { id: "closed-quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12, previousClose: 10, quality: "live", stale: false } },
    ],
  };

  const result = await new DeterministicNarrator().narrate({ workflow: "ask", askScope: "today_change", evidence: closedEvidence });

  assert.match(result.observations[0]?.explanation ?? "", /闭市后的最近观测价/);
  assert.doesNotMatch(result.observations[0]?.explanation ?? "", /最新价/);
});

test("model output cannot cite a sealed item omitted from its bounded narration context", async () => {
  const boundedEvidence: SealedEvidenceBundle = {
    ...evidence,
    workflow: "ask",
    ask: { scope: "today_change", planVersion: "ask-plan.v1" },
    items: [
      {
        id: "snapshot-context",
        kind: "market_fact",
        origin: "server-observed",
        reliable: true,
        value: {
          type: "snapshot_context",
          quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], unavailableCapabilities: [] },
          markets: [{ exchange: "SSE", session: "open", open: true, reliable: true, freshness: "fresh" }],
          capabilities: [],
        },
      },
      ...Array.from({ length: 82 }, (_, index) => ({
        id: `quote-${index}`,
        kind: "market_fact" as const,
        origin: "server-observed" as const,
        reliable: true,
        value: { type: "quote", instrumentId: `SSE:${String(600000 + index).padStart(6, "0")}`, price: 10, previousClose: 10, quality: "live", stale: false },
      })),
    ],
  };
  const narrator: Narrator = {
    async narrate() {
      return {
        status: "success",
        headline: "omitted",
        summary: "omitted",
        observations: [{ id: "omitted", class: "fact", importance: "low", title: "omitted", explanation: "omitted", evidenceIds: ["quote-81"] }],
        portfolioImpacts: [],
        watchNext: [],
        limitations: [],
        evidenceFingerprint: boundedEvidence.fingerprint,
      };
    },
  };

  const result = await narrateWithRepair(narrator, { workflow: "ask", askScope: "today_change", evidence: boundedEvidence });

  assert.equal(result.result.status, "partial");
  assert.match(result.issues.join("\n"), /absent from the narration context/);
});

test("deterministic fallback never promotes an unreliable market event to fact", async () => {
  const eventEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [
      ...evidence.items,
      { id: "event-stale", kind: "market_event", origin: "server-observed", reliable: false, value: { instrumentId: "SSE:600000", kind: "price_rise", actual: 800 } },
    ],
  };

  const result = await new DeterministicNarrator().narrate({ workflow: "close_review", evidence: eventEvidence });

  assert.equal(result.observations[0]?.class, "unknown");
  assert.match(result.observations[0]?.explanation ?? "", /底层行情不可靠/);
});

test("closed-session fallback collapses duplicate quality warnings and never prints raw limitation JSON", async () => {
  const closedEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [
      {
        id: "snapshot-context",
        kind: "market_fact",
        origin: "server-observed",
        reliable: false,
        value: {
          type: "snapshot_context",
          quality: { status: "degraded", reliable: false, freshness: "stale", warnings: ["闭市阶段最近有效收盘应为 2026-08-11 15:00", "报价已过期 733 秒"], unavailableCapabilities: [] },
          markets: [{ exchange: "SSE", session: "closed", open: false, reliable: true, freshness: "fresh" }],
        },
      },
      { id: "stale-quote", kind: "market_fact", origin: "server-observed", reliable: false, value: { type: "quote", instrumentId: "SSE:600000", price: 9.21, quality: "stale", stale: true } },
      { id: "news", kind: "market_fact", origin: "server-observed", reliable: false, value: { evidenceType: "news", title: "fixture", warnings: ["external_text_is_untrusted"] } },
      { id: "quotes-limit", kind: "limitation", origin: "server-observed", reliable: true, value: { capability: "quotes", status: "degraded", warnings: ["闭市阶段最近有效收盘应为 2026-08-11 15:00", "报价已过期 733 秒"] } },
      { id: "empty-limit", kind: "limitation", origin: "server-observed", reliable: true, value: { capability: "announcements:SSE:600000", status: "degraded", warnings: [] } },
      { id: "quality-limit", kind: "limitation", origin: "server-observed", reliable: true, value: { quality: "degraded", freshness: "stale", warnings: ["闭市阶段最近有效收盘应为 2026-08-11 15:00", "报价已过期 733 秒"], unavailableCapabilities: [] } },
    ],
  };

  const result = await new DeterministicNarrator().narrate({ workflow: "close_review", evidence: closedEvidence });
  const joined = result.limitations.join("\n");

  assert.doesNotMatch(joined, /证据限制|\{"capability"/);
  assert.equal(result.limitations.filter((item) => item.includes("闭市阶段最近有效收盘")).length, 1);
  assert.equal(result.limitations.filter((item) => item.includes("报价已过期")).length, 1);
  assert.doesNotMatch(joined, /announcements:SSE:600000/);
});
