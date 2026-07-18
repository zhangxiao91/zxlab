import assert from "node:assert/strict";
import test from "node:test";
import { RiskReviewError, validateLLMReview, verifyCloudflareAccess } from "../functions/_lib/risk/review.ts";
import { handleRiskReview } from "../functions/api/risk/review.ts";
import { calculateRisk } from "../src/features/risk/engine.ts";
import { buildPositionsDetailed, reconcilePositions } from "../src/features/risk/ledger.ts";
import { instruments, mockPortfolioHistory, mockQuotes, mockRiskRules, mockTradePlans, mockTransactions } from "../src/features/risk/mock.ts";
import { ApiReviewError, ApiReviewService, fingerprintEvidencePack, LocalReviewRepository } from "../src/features/risk/review.ts";
import type { EvidencePack, ReviewExecution } from "../src/features/risk/types.ts";

const reviewMetadata = { provider: "provider1", model: "gpt", fallbackIndex: 0, requestId: "gateway-1", latencyMs: 20, inputTokens: 100, outputTokens: 50, retryCount: 1 };

function evidencePack(): EvidencePack {
  const built = buildPositionsDetailed(mockTransactions, instruments);
  const reconciliation = reconcilePositions(built, built.positions.map((item) => ({ instrumentId: item.instrumentId, quantity: item.quantity, averageCost: item.averageCost })));
  return calculateRisk({ transactions: mockTransactions, positions: built.positions, quotes: mockQuotes, tradePlans: mockTradePlans, riskRules: mockRiskRules, portfolioHistory: mockPortfolioHistory, reconciliation, now: "2026-07-18T14:32:11+08:00" }).evidencePack;
}

function llmOutput(pack: EvidencePack) {
  const evidenceId = pack.evidence[0].id;
  return {
    summary: "本轮只解释确定性风险事件。",
    mainRisks: [{ title: "仓位风险", explanation: "仓位指标需要复核。", severity: "high", evidenceIds: [evidenceId] }],
    planViolations: [],
    operationReview: [{ category: "仓位错误", observation: "仓位偏离计划。", evidenceIds: [evidenceId] }],
    counterfactuals: ["如果遵守计划上限，敞口如何变化？"],
    unknowns: pack.warnings,
    questionsForUser: ["是否完成券商对账？"],
    limitations: ["内容不构成投资建议。"],
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("Evidence Pack fingerprint ignores runtime timestamps but changes with quote facts", async () => {
  const pack = evidencePack();
  const refreshed = structuredClone(pack);
  refreshed.id = "evidence-pack:later"; refreshed.generatedAt = "2026-07-18T15:00:00+08:00";
  refreshed.events.forEach((event) => { event.triggeredAt = refreshed.generatedAt; });
  refreshed.evidence.forEach((item) => { item.timestamp = refreshed.generatedAt; });
  assert.equal(await fingerprintEvidencePack(pack), await fingerprintEvidencePack(refreshed));
  const changed = structuredClone(refreshed);
  const quote = changed.evidence.find((item) => item.type === "行情");
  assert.ok(quote); quote.payload.price = Number(quote.payload.price) + 0.01;
  assert.notEqual(await fingerprintEvidencePack(pack), await fingerprintEvidencePack(changed));
});

test("LocalReviewRepository saves only successful LLM reviews and reuses the fingerprint", async () => {
  const pack = evidencePack(); const fingerprint = await fingerprintEvidencePack(pack);
  const repository = new LocalReviewRepository(new MemoryStorage());
  const execution = await validateLLMReview(llmOutput(pack), pack, reviewMetadata);
  repository.save(execution.result);
  assert.equal(repository.find(fingerprint)?.requestId, "gateway-1");
  repository.save({ ...execution.result, mode: "mock" });
  assert.equal(repository.find(fingerprint)?.mode, "llm");
});

test("ApiReviewService parses success and preserves structured errors", async () => {
  const pack = evidencePack();
  const execution = await validateLLMReview(llmOutput(pack), pack, reviewMetadata);
  const service = new ApiReviewService("/api/risk/review", async () => Response.json({ ok: true, data: execution, requestId: "risk-1" }));
  assert.equal((await service.review(pack)).result.mode, "llm");
  const failing = new ApiReviewService("/api/risk/review", async () => Response.json({ ok: false, error: { code: "ACCESS_REQUIRED", message: "login" }, requestId: "risk-2" }, { status: 401 }));
  await assert.rejects(failing.review(pack), (error: unknown) => error instanceof ApiReviewError && error.code === "ACCESS_REQUIRED" && error.requestId === "risk-2");
  const controller = new AbortController(); controller.abort();
  const aborting = new ApiReviewService("/api/risk/review", async (_input, init) => { assert.equal(init?.signal?.aborted, true); throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(aborting.review(pack, { signal: controller.signal }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("Cloudflare Access verifier fails closed for missing and malformed assertions", async () => {
  const env = { RISK_ACCESS_TEAM_DOMAIN: "https://zxlab.cloudflareaccess.com", RISK_ACCESS_AUD: "risk-audience" };
  await assert.rejects(verifyCloudflareAccess(new Request("https://beta.zxlab.pages.dev/api/risk/review"), env), (error: unknown) => error instanceof RiskReviewError && error.code === "ACCESS_REQUIRED");
  await assert.rejects(verifyCloudflareAccess(new Request("https://beta.zxlab.pages.dev/api/risk/review", { headers: { "Cf-Access-Jwt-Assertion": "forged-token" } }), env), (error: unknown) => error instanceof RiskReviewError && error.code === "INVALID_ACCESS_TOKEN");
  await assert.rejects(verifyCloudflareAccess(new Request("https://beta.zxlab.pages.dev/api/risk/review", { headers: { Cookie: "other=value; CF_Authorization=forged-token" } }), env), (error: unknown) => error instanceof RiskReviewError && error.code === "INVALID_ACCESS_TOKEN");
});

test("LLM review excludes unsupported facts, tolerates unknown fields, and rejects trading instructions", async () => {
  const pack = evidencePack(); const metadata = reviewMetadata;
  const fabricated = llmOutput(pack); fabricated.mainRisks[0].evidenceIds = ["invented:evidence"];
  const fabricatedResult = await validateLLMReview({ ...fabricated, futureField: "compatible" }, pack, metadata);
  assert.equal(fabricatedResult.status, "partial"); assert.equal(fabricatedResult.result.mainRisks.length, 0); assert.ok(fabricatedResult.warnings.some((item) => item.includes("evidenceIds")));
  const invalidSeverity = llmOutput(pack); invalidSeverity.mainRisks[0].severity = "urgent";
  const invalidSeverityResult = await validateLLMReview(invalidSeverity, pack, metadata);
  assert.equal(invalidSeverityResult.status, "partial"); assert.equal(invalidSeverityResult.result.mainRisks.length, 0);
  const command = llmOutput(pack); command.summary = "立即卖出该持仓";
  await assert.rejects(validateLLMReview(command, pack, metadata), (error: unknown) => error instanceof RiskReviewError && error.code === "FORBIDDEN_TRADING_INSTRUCTION");
});

test("Risk Review Function requires Access, calls the gateway, and degrades invalid model output", async () => {
  const pack = evidencePack();
  const request = new Request("https://beta.zxlab.pages.dev/api/risk/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evidencePack: pack }) });
  const missing = await handleRiskReview({ request: request.clone(), env: {} });
  assert.equal(missing.status, 503);
  const gateway = async () => Response.json({ ok: true, data: { json: llmOutput(pack), text: "{}", provider: "provider1", model: "gpt", fallbackIndex: 0, latencyMs: 20 }, requestId: "gateway-1" });
  const success = await handleRiskReview({ request: request.clone(), env: { AI_GATEWAY_ACCESS_TOKEN: "server-secret" } }, { verifyAccess: async () => ({}), fetcher: gateway });
  const successPayload = await success.json() as { data: ReviewExecution };
  assert.equal(successPayload.data.result.mode, "llm"); assert.equal(successPayload.data.result.requestId, "gateway-1"); assert.equal(successPayload.data.inputTokens, null);
  const invalidGateway = async () => Response.json({ ok: true, data: { json: { ...llmOutput(pack), summary: "立即买入" }, text: "{}", provider: "provider1", model: "gpt", fallbackIndex: 0, latencyMs: 20 }, requestId: "gateway-2" });
  const degraded = await handleRiskReview({ request: request.clone(), env: { AI_GATEWAY_ACCESS_TOKEN: "server-secret" } }, { verifyAccess: async () => ({}), fetcher: invalidGateway });
  const degradedPayload = await degraded.json() as { data: ReviewExecution };
  assert.equal(degradedPayload.data.result.mode, "mock"); assert.equal(degradedPayload.data.result.fallbackReason, "FORBIDDEN_TRADING_INSTRUCTION");
});

test("Risk Review Function rejects oversized requests before parsing", async () => {
  const request = new Request("https://beta.zxlab.pages.dev/api/risk/review", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(300 * 1024) }, body: "{}" });
  const response = await handleRiskReview({ request, env: {} }, { verifyAccess: async () => ({}) });
  const payload = await response.json() as { error: { code: string } };
  assert.equal(response.status, 413); assert.equal(payload.error.code, "EVIDENCE_TOO_LARGE");
});
