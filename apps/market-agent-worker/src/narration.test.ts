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
  assert.equal(result.provenance.source, "model_repaired");
});

test("forbidden trade instruction falls back deterministically", async () => {
  const narrator: Narrator = { async narrate() { return { status: "success", headline: "买入", summary: "buy now", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint }; } };
  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence });
  assert.equal(result.result.status, "partial"); assert.match(result.result.limitations.at(-1) ?? "", /降级/);
  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.equal(result.provenance.failure?.stage, "validation");
  assert.deepEqual(result.provenance.failure?.validationCategories, ["trading_policy"]);
  assert.deepEqual(result.provenance.failure?.validationRuleIds, ["trading_instruction"]);
});

test("gateway failure exposes structured deterministic fallback provenance", async () => {
  const narrator: Narrator = { async narrate() { throw new Error("MARKET_AGENT_GATEWAY_HTTP_503_ALL_CANDIDATES_FAILED"); } };
  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.deepEqual(result.provenance.failure, { stage: "gateway", code: "ALL_CANDIDATES_FAILED", retryable: true });
});

test("deterministic narration preserves a reliable point-in-time Snapshot diff", async () => {
  const withDiff: SealedEvidenceBundle = {
    ...evidence,
    items: [...evidence.items, {
      id: "snapshot-diff",
      kind: "snapshot_diff",
      origin: "server-observed",
      reliable: true,
      value: { previousAsOf: "2026-08-04T08:00:00.000Z", currentAsOf: "2026-08-05T08:00:00.000Z", changes: [{ kind: "quote_price", instrumentId: "SSE:600000", previous: 10, current: 11, delta: 1, deltaBps: 1000 }] },
    }],
  };

  const result = await new DeterministicNarrator().narrate({ workflow: "close_review", evidence: withDiff });

  assert.ok(result.observations.some((item) => item.title.includes("较上次") && item.evidenceIds.includes("snapshot-diff")));
});

test("Chinese inference wording passes uncertainty validation", async () => {
  const candidate = {
    status: "success",
    headline: "盘后观察",
    summary: "当前没有显著事件。",
    observations: [{
      id: "inference-1",
      class: "inference",
      importance: "low",
      title: "成交变化",
      explanation: "根据现有证据推测，成交变化尚无法确认其持续性。",
      evidenceIds: ["fact-1"],
    }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: evidence.fingerprint,
  };
  const narrator: Narrator = { async narrate() { return candidate; } };
  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence });
  assert.equal(result.result.status, "success");
  assert.equal(result.result.headline, candidate.headline);
  assert.equal(result.provenance.source, "model");
});

test("model narration cannot calculate or fill a number absent from sealed facts", async () => {
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "盘后观察",
    summary: "模型自行补出 20% 的变化。",
    observations: [{ id: "invented", class: "fact", importance: "high", title: "变化幅度", explanation: "变化达到 20%。", evidenceIds: ["fact-1"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: evidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.match(result.issues.join("\n"), /numeric claims must match sealed deterministic facts: 20%/);
  assert.deepEqual(result.provenance.failure?.validationCategories, ["numeric_grounding"]);
  assert.deepEqual(result.provenance.failure?.validationRuleIds, ["numeric_claim"]);
});

test("an unrelated execution-plan count cannot ground a numeric quote claim", async () => {
  const scopedEvidence: SealedEvidenceBundle = {
    ...evidence,
    workflow: "ask",
    ask: { scope: "today_change", planVersion: "ask-plan.v1" },
    items: [
      { id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12 } },
      { id: "plan", kind: "execution_plan", origin: "server-observed", reliable: true, value: { type: "ask_plan", resolvedInstrumentCount: 20 } },
    ],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "盘后观察",
    summary: "所引行情没有提供变化幅度。",
    observations: [{ id: "invented", class: "fact", importance: "high", title: "变化幅度", explanation: "该股上涨 20。", evidenceIds: ["quote"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: scopedEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "ask", askScope: "today_change", evidence: scopedEvidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.match(result.issues.join("\n"), /observations\[0\].*20/);
});

test("a number from another reliable evidence item cannot ground the wrong observation", async () => {
  const quoteEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [
      { id: "quote-12", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12 } },
      { id: "quote-20", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600001", price: 20 } },
    ],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "盘后观察",
    summary: "可靠行情均已封存。",
    observations: [
      { id: "wrong", class: "fact", importance: "high", title: "目标价格", explanation: "目标价格为 20。", evidenceIds: ["quote-12"] },
      { id: "other", class: "fact", importance: "low", title: "对照行情", explanation: "对照行情可用。", evidenceIds: ["quote-20"] },
    ],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: quoteEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: quoteEvidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.match(result.issues.join("\n"), /observations\[0\].*20/);
});

test("quantity-bearing Chinese numerals are rejected when they cannot be bound exactly", async () => {
  const quoteEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [{ id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 20 } }],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "盘后观察",
    summary: "可靠行情事实可用。",
    observations: [{ id: "invented", class: "fact", importance: "high", title: "变化幅度", explanation: "该股上涨二十个百分点。", evidenceIds: ["quote"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: quoteEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: quoteEvidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.match(result.issues.join("\n"), /observations\[0\].*二十个百分点/);
});

test("a correctly cited reliable quote can ground its own numeric value", async () => {
  const quoteEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [{ id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12 } }],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "盘后观察",
    summary: "可靠观测价格为 12。",
    conclusionEvidenceIds: ["quote"],
    observations: [{ id: "price", class: "fact", importance: "high", title: "观测价格", explanation: "封存观测价格为 12。", evidenceIds: ["quote"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: quoteEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: quoteEvidence });

  assert.equal(result.provenance.source, "model");
  assert.deepEqual(result.issues, []);
});

test("an instrument identifier is not mistaken for a numeric claim", async () => {
  const quoteEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [{ id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12 } }],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "SSE:600000 盘后观察",
    summary: "该标的已形成封存行情。当前报告不补算变化幅度。",
    conclusionEvidenceIds: ["quote"],
    observations: [{ id: "quote", class: "fact", importance: "medium", title: "SSE:600000 行情事实", explanation: "封存价格为 12。", evidenceIds: ["quote"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: quoteEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: command.workflow, evidence: quoteEvidence });

  assert.equal(result.provenance.source, "model");
  assert.equal(result.issues.length, 0);
});

test("numeric text from news and announcement bodies is never claimable evidence", async () => {
  const externalEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [{
      id: "announcement",
      kind: "market_fact",
      origin: "server-observed",
      reliable: true,
      value: { evidenceType: "announcement", id: "announcement-20", title: "公告声称增长 20", content: "未经确定性算子处理的自由文本。", publishedAt: "2026-08-15T07:00:00.000Z" },
    }],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "公告观察",
    summary: "公告文本仅作为外部材料。",
    observations: [{ id: "announcement", class: "fact", importance: "high", title: "增长幅度", explanation: "增长达到 20。", evidenceIds: ["announcement"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: externalEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: externalEvidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.match(result.issues.join("\n"), /observations\[0\].*20/);
});

test("a correctly cited reliable Research Fact can ground its deterministic decimal", async () => {
  const researchEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [{
      id: "research-baseline",
      kind: "market_fact",
      origin: "server-observed",
      reliable: true,
      value: {
        type: "research_fact",
        researchFingerprint: "sha256:research",
        planVersion: "price-context.v1",
        purpose: "price_context",
        fact: {
          id: "baseline:SSE:600000:price_return:20",
          kind: "market_baseline",
          subjectId: "SSE:600000",
          baselineType: "price_return",
          window: 20,
          value: { decimal: "0.1234", unit: "ratio" },
          formula: { id: "market.price_return.v1", version: "1", inputArtifactIds: ["bars:fixture"] },
        },
      },
    }],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "历史基线",
    summary: "确定性研究事实可用。",
    observations: [{ id: "baseline", class: "fact", importance: "high", title: "收益基线", explanation: "20 日基线的确定性收益小数为 0.1234。", evidenceIds: ["research-baseline"] }],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: researchEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: researchEvidence });

  assert.equal(result.provenance.source, "model");
  assert.deepEqual(result.issues, []);
});

test("each report section accepts only numbers from its cited deterministic evidence", async () => {
  const sectionEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [
      { id: "event", kind: "market_event", origin: "server-observed", reliable: true, value: { instrumentId: "SSE:600000", kind: "price_rise", actual: 800, threshold: 500 } },
      { id: "diff", kind: "snapshot_diff", origin: "server-observed", reliable: true, value: { changes: [{ kind: "quote_price", instrumentId: "SSE:600000", previous: 10, current: 11, delta: 1, deltaBps: 1000 }] } },
      { id: "bars", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "bar_series", instrumentId: "SSE:600000", interval: "1d", bars: [{ timestamp: "2026-08-14T07:00:00.000Z", close: 11, volume: 3000 }] } },
      { id: "impact", kind: "portfolio_impact", origin: "server-observed", reliable: true, value: { type: "risk_impact", impact: { marketValue: 1200, costBasis: 1000, unrealizedPnl: 200, concentration: [{ instrumentId: "SSE:600000", weight: 1 }] } } },
    ],
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "确定性复盘",
    summary: "各章节分别引用自己的封存证据。",
    observations: [
      { id: "event", class: "fact", importance: "high", title: "规则事件", explanation: "规则事件实际值为 800。", evidenceIds: ["event"] },
      { id: "bars", class: "fact", importance: "medium", title: "日线收盘", explanation: "所引日线收盘值为 11。", evidenceIds: ["bars"] },
    ],
    portfolioImpacts: [{ id: "impact", class: "fact", importance: "medium", title: "持仓市值", explanation: "确定性重估市值为 1200。", evidenceIds: ["impact"] }],
    watchNext: [{ condition: "差分达到 1000 bps", reason: "这是已封存的差分阈值。", evidenceIds: ["diff"] }],
    limitations: [],
    evidenceFingerprint: sectionEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: sectionEvidence });

  assert.equal(result.provenance.source, "model");
  assert.deepEqual(result.issues, []);
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
  assert.match(result.issues.join("\n"), /observations\[0\].*12/);
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
        observations: [{ id: "omitted", class: "fact", importance: "low", title: "omitted", explanation: "被省略证据中的价格为 91。", evidenceIds: ["quote-81"] }],
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
  assert.match(result.issues.join("\n"), /observations\[0\].*91/);
});

test("conclusion evidence must also be present in the bounded narration context", async () => {
  const crowdedEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: Array.from({ length: 82 }, (_, index) => ({
      id: `quote-${index}`,
      kind: "market_fact" as const,
      origin: "server-observed" as const,
      reliable: true,
      value: { type: "quote", instrumentId: `SSE:${String(600000 + index).padStart(6, "0")}`, price: 10 + index, previousClose: 10, quality: "live", stale: false },
    })),
  };
  const narrator: Narrator = { async narrate() { return {
    status: "success",
    headline: "结论",
    summary: "结论只可引用模型真正看到的证据。",
    conclusionEvidenceIds: ["quote-81"],
    observations: [],
    portfolioImpacts: [],
    watchNext: [],
    limitations: [],
    evidenceFingerprint: crowdedEvidence.fingerprint,
  }; } };

  const result = await narrateWithRepair(narrator, { workflow: "close_review", evidence: crowdedEvidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.match(result.issues.join("\n"), /conclusionEvidenceIds.*absent from the narration context/);
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
