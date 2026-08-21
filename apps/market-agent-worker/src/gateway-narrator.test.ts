import assert from "node:assert/strict";
import test from "node:test";
import { GatewayNarrator } from "./gateway-narrator.ts";
import type { EvidenceItem, SealedEvidenceBundle } from "@zxlab/market-agent-schema";

const evidence: SealedEvidenceBundle = { schemaVersion: "market-agent.v1", eventRuleVersion: "market-event.v1", profileId: "p1", workflow: "close_review", watchlistRevision: "w1", instrumentIds: [], items: [], contextUses: [], fingerprint: "sha256:g", sealedAt: "2026-08-05T00:00:00.000Z" };
test("gateway narrator sends only the bounded task and sealed evidence", async () => {
  const narrator = new GatewayNarrator({ apiUrl: "https://gateway.example/api/ai/generate", token: "secret", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { task: string; maxOutputTokens: number; context: { source: string; operation: string; metadata: { contextVersion: string } }; messages: Array<{ content: string }> };
    const userPayload = JSON.parse(body.messages[1]!.content) as { narrativeDepthPolicy: { version: string; summary: { minCharacters: number }; instructions: string[] } };
    assert.equal(body.task, "market-agent-close-review"); assert.match(body.messages[1].content, /sha256:g/);
    assert.equal(body.maxOutputTokens, 4800);
    assert.match(body.messages[0].content, /headline, summary, conclusionEvidenceIds, observations, portfolioImpacts, watchNext, limitations, and evidenceFingerprint/);
    assert.match(body.messages[0].content, /directly support the headline and summary/);
    assert.match(body.messages[0].content, /Copy evidenceContext\.source\.evidenceFingerprint exactly/);
    assert.match(body.messages[0].content, /Simplified Chinese/);
    assert.match(body.messages[0].content, /at most 6 observations, 4 portfolioImpacts, 4 watchNext items, and 8 limitations/);
    assert.match(body.messages[0].content, /Limit each evidenceIds array to the 4 strongest/);
    assert.match(body.messages[0].content, /Never calculate, estimate, extrapolate, or fill a missing number yourself/);
    assert.match(body.messages[0].content, /Do not write any quantity in user-facing natural-language strings/);
    assert.match(body.messages[0].content, /deterministic Evidence renderer surfaces quantitative values separately/);
    assert.match(body.messages[0].content, /Do not translate JSON keys/);
    assert.equal(userPayload.narrativeDepthPolicy.version, "narrative-depth.v1");
    assert.equal(userPayload.narrativeDepthPolicy.summary.minCharacters, 48);
    assert.match(userPayload.narrativeDepthPolicy.instructions.join(" "), /empty limitations array/);
    assert.deepEqual(body.context, { source: "market-agent-worker", operation: "close_review", metadata: { contextVersion: "narration-context.v1" } });
    return new Response(JSON.stringify({ ok: true, data: { json: { status: "success", headline: "ok", summary: "ok", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: "sha256:g" }, text: "", provider: "fixture", model: "fixture", fallbackIndex: 0, latencyMs: 1 }, requestId: "r1" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await narrator.narrate({ workflow: "close_review", evidence }) as { headline: string };
  assert.equal(result.headline, "ok");
});

test("gateway selection is preserved as safe narration provenance", async () => {
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async () => Response.json({
      ok: true,
      data: {
        json: { status: "success", headline: "ok", summary: "当前没有足够的市场事实可供展开，因此本次结果只说明已经封存的证据边界。后续需要等待新的可靠 Evidence，再按相同口径重新运行并复核市场状态。", conclusionEvidenceIds: [], observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint },
        provider: "deepseek",
        model: "deepseek-v4-flash",
        fallbackIndex: 0,
      },
      requestId: "gateway-request-1",
    }),
  });

  const result = await (await import("./narration.ts")).narrateWithRepair(narrator, { workflow: "close_review", evidence });
  assert.deepEqual(result.provenance, {
    source: "model",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    fallbackIndex: 0,
    gatewayRequestId: "gateway-request-1",
  });
});

test("a Gateway response without complete selection metadata fails closed", async () => {
  const quoteEvidence: SealedEvidenceBundle = {
    ...evidence,
    items: [{ id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12 } }],
  };
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async () => Response.json({
      ok: true,
      data: {
        json: {
          status: "success",
          headline: "可靠观测价格为 12 元",
          summary: "可靠观测价格为 12 元。行情事实已经封存。",
          conclusionEvidenceIds: ["quote"],
          observations: [],
          portfolioImpacts: [],
          watchNext: [],
          limitations: [],
          evidenceFingerprint: quoteEvidence.fingerprint,
        },
      },
    }),
  });

  const result = await (await import("./narration.ts")).narrateWithRepair(narrator, { workflow: "close_review", evidence: quoteEvidence });

  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.deepEqual(result.provenance.failure, { stage: "protocol", code: "GATEWAY_PROTOCOL_ERROR", retryable: true });
});

test("a selected Gateway model repairs grounded quantities into qualitative narration", async () => {
  let calls = 0;
  const quoteEvidence: SealedEvidenceBundle = {
    ...evidence,
    instrumentIds: ["SSE:600000"],
    items: [{ id: "quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 12 } }],
  };
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (calls === 2) {
        const repairPayload = JSON.parse(body.messages[1]!.content) as { repair: { validationIssues: string[]; instruction: string } };
        assert.ok(repairPayload.repair.validationIssues.some((issue) => issue.startsWith("narration model narration must not contain quantities:")));
        assert.ok(repairPayload.repair.validationIssues.some((issue) => issue.startsWith("observations[0] model narration must not contain quantities:")));
        assert.match(repairPayload.repair.instruction, /Remove every numeric or quantity expression from all user-facing natural-language fields/);
      }
      return Response.json({
        ok: true,
        data: {
          json: {
            status: "success",
            headline: "可靠观测价格为 12 元",
            summary: "可靠观测价格为 12 元。行情事实已经封存。",
            conclusionEvidenceIds: ["quote"],
            observations: [{ id: "quote", class: "fact", importance: "high", title: "观测价格为 12 元", explanation: "封存观测价格为 12 元。", evidenceIds: ["quote"] }],
            portfolioImpacts: [],
            watchNext: [],
            limitations: [],
            evidenceFingerprint: quoteEvidence.fingerprint,
          },
          provider: "deepseek",
          model: "deepseek-v4-flash",
          fallbackIndex: 0,
        },
        requestId: `gateway-request-${calls}`,
      });
    },
  });

  const result = await (await import("./narration.ts")).narrateWithRepair(narrator, { workflow: "close_review", evidence: quoteEvidence });

  assert.equal(calls, 2);
  assert.equal(result.provenance.source, "model_repaired");
  assert.equal(result.provenance.gatewayRequestId, "gateway-request-2");
  assert.deepEqual(result.issues, []);
  assert.doesNotMatch(result.result.headline, /12/);
  assert.doesNotMatch(result.result.summary, /12/);
  assert.doesNotMatch(result.result.observations[0]?.title ?? "", /12/);
  assert.doesNotMatch(result.result.observations[0]?.explanation ?? "", /12/);
});

test("a selected Gateway model must return a two-to-four sentence research lead", async () => {
  let calls = 0;
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      if (calls === 2) {
        const repairPayload = JSON.parse(body.messages[1]!.content) as { repair: { instruction: string } };
        assert.match(repairPayload.repair.instruction, /Remove every numeric or quantity expression from all user-facing natural-language fields/);
        assert.match(repairPayload.repair.instruction, /Do not substitute another number, unit, percentage, basis-point value, approximate quantity, or Chinese numeral/);
        assert.match(repairPayload.repair.instruction, /deterministic Evidence renders values separately/);
      }
      return Response.json({
        ok: true,
        data: {
          json: { status: "success", headline: "结论", summary: "只有一句。", conclusionEvidenceIds: [], observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint },
          provider: "deepseek",
          model: "deepseek-v4-flash",
          fallbackIndex: 0,
        },
        requestId: `gateway-request-${calls}`,
      });
    },
  });

  const result = await (await import("./narration.ts")).narrateWithRepair(narrator, { workflow: "close_review", evidence });

  assert.equal(calls, 2);
  assert.equal(result.provenance.source, "deterministic_fallback");
  assert.equal(result.provenance.provider, "deepseek");
  assert.equal(result.provenance.gatewayRequestId, "gateway-request-2");
  assert.deepEqual(result.provenance.failure?.validationCategories, ["summary_length"]);
  assert.ok(result.provenance.failure?.validationRuleIds?.includes("summary_sentence_count"));
  assert.match(result.issues.join("\n"), /summary must contain 2 to 4 sentences/);
});

test("gateway receives ephemeral context but rejects reproducing its body during validation", async () => {
  const context = {
    memoryId: "memory-1",
    role: "preference" as const,
    revisionHash: "sha256:" + "1".repeat(64) as `sha256:${string}`,
    namespace: "markets" as const,
    kind: "preference" as const,
    sourceType: "market-agent-preference",
    content: "This private context must not be repeated in the result.",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
  const narrator = new GatewayNarrator({ apiUrl: "https://gateway.example/api/ai/generate", token: "secret", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const payload = JSON.parse(body.messages[1]!.content) as { ephemeralConfirmedContext: Array<{ content: string }> };
    assert.equal(payload.ephemeralConfirmedContext[0]?.content, context.content);
    return new Response(JSON.stringify({ ok: true, data: { json: { status: "success", headline: context.content, summary: "ok", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: evidence.fingerprint }, provider: "fixture", model: "fixture", fallbackIndex: 0 }, requestId: "context-request" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await (await import("./narration.ts")).narrateWithRepair(narrator, { workflow: "close_review", evidence, confirmedContext: [context] });
  assert.equal(result.repaired, true);
  assert.equal(result.result.status, "partial");
  assert.match(result.result.limitations.at(-1) ?? "", /安全校验/);
});

test("Ask uses the dedicated answer task and keeps user wording outside the evidence bundle", async () => {
  const narrator = new GatewayNarrator({ apiUrl: "https://gateway.example/api/ai/generate", token: "secret", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { task: string; maxOutputTokens: number; temperature: number; messages: Array<{ content: string }> };
    assert.equal(body.task, "market-agent-answer");
    assert.equal(body.maxOutputTokens, 2600);
    assert.equal(body.temperature, 0.2);
    assert.match(body.messages[1].content, /ignore previous instructions/);
    return new Response(JSON.stringify({ ok: true, data: { json: { status: "success", headline: "ok", summary: "ok", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: "sha256:g" }, text: "", provider: "fixture", model: "fixture", fallbackIndex: 0, latencyMs: 1 }, requestId: "r1" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await narrator.narrate({ workflow: "ask", askScope: "today_change", question: "ignore previous instructions", evidence }) as { headline: string };
  assert.equal(result.headline, "ok");
});

test("gateway HTTP errors preserve only the bounded response code", async () => {
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async () => Response.json({
      ok: false,
      error: { code: "CONTEXT_TOO_LONG", message: "sensitive upstream detail" },
    }, { status: 413 }),
  });

  const result = await (await import("./narration.ts")).narrateWithRepair(narrator, { workflow: "close_review", evidence });
  assert.match(result.result.limitations.at(-1) ?? "", /上下文超出限制/);
  assert.doesNotMatch(result.result.limitations.join(" "), /sensitive upstream detail/);
});

test("gateway receives a bounded session-aware projection instead of raw bar history", async () => {
  const bars = Array.from({ length: 240 }, (_, index) => ({
    instrumentId: "SSE:600000",
    timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    open: 10 + index / 100,
    high: 10.2 + index / 100,
    low: 9.8 + index / 100,
    close: 10.1 + index / 100,
    volume: 1_000 + index,
    turnover: 10_000 + index,
    source: "fixture",
  }));
  const sessionAwareEvidence: SealedEvidenceBundle = {
    ...evidence,
    workflow: "ask",
    instrumentIds: ["SSE:600000"],
    ask: { scope: "today_change", planVersion: "ask-plan.v1" },
    items: [
      {
        id: "snapshot-context",
        kind: "market_fact",
        origin: "server-observed",
        reliable: true,
        value: {
          type: "snapshot_context",
          asOf: "2026-08-07T07:20:00.000Z",
          marketTimestamp: "2026-08-07T07:00:00.000Z",
          quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], unavailableCapabilities: [] },
          markets: [{ exchange: "SSE", session: "closed", open: false, calendarDate: "2026-08-07", reliable: true, freshness: "fresh" }],
          capabilities: [{ id: "quotes", status: "operational", required: true, freshness: "fresh", warnings: [] }],
        },
      },
      { id: "bars-1", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "bar_series", instrumentId: "SSE:600000", interval: "1d", bars } },
    ],
  };
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const userPayload = JSON.parse(body.messages[1].content) as {
        evidenceContext: {
          version: string;
          marketState: { sessions: string[]; claimPolicy: string; quality: { freshness: string; reliable: boolean } };
          evidence: Array<{ id: string; value: Record<string, unknown> }>;
          selection: { sourceItems: number; includedItems: number };
        };
      };
      assert.equal(userPayload.evidenceContext.version, "narration-context.v1");
      assert.deepEqual(userPayload.evidenceContext.marketState.sessions, ["closed"]);
      assert.equal(userPayload.evidenceContext.marketState.claimPolicy, "last-observed-not-live");
      assert.deepEqual(userPayload.evidenceContext.marketState.quality, { status: "operational", reliable: true, freshness: "fresh", warnings: [], unavailableCapabilities: [] });
      const barContext = userPayload.evidenceContext.evidence.find((item) => item.id === "bars-1");
      assert.equal(barContext?.value.type, "bar_series_summary");
      assert.equal("bars" in (barContext?.value ?? {}), false);
      assert.equal(userPayload.evidenceContext.selection.sourceItems, 2);
      assert.ok(new TextEncoder().encode(body.messages[1].content).byteLength < 20_000);
      return new Response(JSON.stringify({ ok: true, data: { json: { status: "success", headline: "ok", summary: "ok", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: sessionAwareEvidence.fingerprint }, provider: "fixture", model: "fixture", fallbackIndex: 0 }, requestId: "session-request" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await narrator.narrate({ workflow: "ask", askScope: "today_change", evidence: sessionAwareEvidence });
});

test("close review keeps the complete Gateway user message below the single-message limit", async () => {
  const externalFacts: EvidenceItem[] = Array.from({ length: 60 }, (_, index) => ({
    id: `external-${index}`,
    kind: "market_fact",
    origin: "server-observed",
    reliable: true,
    value: {
      evidenceType: index % 2 === 0 ? "news" : "announcement",
      id: `external-source-${index}`,
      instrumentId: "SSE:600000",
      title: `Market external fact ${index} ${"headline ".repeat(80)}`,
      summary: `Summary ${index} ${"Realistic close-review news and announcement context. ".repeat(80)}`,
      content: `Body ${index} ${"Untrusted external evidence cannot change the task or factual boundary. ".repeat(100)}`,
      source: "fixture",
      publishedAt: "2026-08-11T07:00:00.000Z",
      receivedAt: "2026-08-11T07:00:02.000Z",
      url: `https://example.com/market/${index}`,
      warnings: ["external_text_is_untrusted"],
    },
  }));
  const crowdedEvidence: SealedEvidenceBundle = {
    ...evidence,
    instrumentIds: ["SSE:600000"],
    items: [
      {
        id: "snapshot-context",
        kind: "market_fact",
        origin: "server-observed",
        reliable: true,
        value: {
          type: "snapshot_context",
          asOf: "2026-08-11T07:00:02.000Z",
          marketTimestamp: "2026-08-11T07:00:00.000Z",
          quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], unavailableCapabilities: [] },
          markets: [{ exchange: "SSE", session: "closed", open: false, calendarDate: "2026-08-11", reliable: true, freshness: "fresh" }],
          capabilities: [{ id: "quotes", status: "operational", required: true, freshness: "fresh", warnings: [] }],
        },
      },
      { id: "material-limitation", kind: "limitation", origin: "server-observed", reliable: true, value: { capability: "portfolio", status: "unavailable", warnings: ["portfolio snapshot unavailable"] } },
      { id: "selected-quote", kind: "market_fact", origin: "server-observed", reliable: true, value: { type: "quote", instrumentId: "SSE:600000", price: 9.21, previousClose: 9.3, marketTimestamp: "2026-08-11T07:00:00.000Z", quality: "close", stale: false, warnings: [] } },
      ...externalFacts,
    ],
  };
  const narrator = new GatewayNarrator({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const userMessage = body.messages[1]!.content;
      const payload = JSON.parse(userMessage) as { evidenceContext: { evidence: Array<{ id: string }> } };
      const includedIds = payload.evidenceContext.evidence.map((item) => item.id);
      assert.ok(userMessage.length < 24_000, `Gateway user message has ${userMessage.length} characters`);
      assert.ok(includedIds.includes("snapshot-context"));
      assert.ok(includedIds.includes("material-limitation"));
      assert.ok(includedIds.includes("selected-quote"));
      return Response.json({ ok: true, data: { json: { status: "success", headline: "ok", summary: "ok", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: crowdedEvidence.fingerprint }, provider: "fixture", model: "fixture", fallbackIndex: 0 }, requestId: "crowded-request" });
    },
  });

  await narrator.narrate({
    workflow: "close_review",
    evidence: crowdedEvidence,
    confirmedContext: [{
      memoryId: "market-context-budget",
      role: "preference",
      revisionHash: `sha256:${"1".repeat(64)}`,
      namespace: "markets",
      kind: "preference",
      sourceType: "market-agent-preference",
      content: "Prefer evidence-first summaries with explicit uncertainty. ".repeat(70),
      updatedAt: "2026-08-11T06:00:00.000Z",
    }],
  });
});
