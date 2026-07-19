import type { EvidencePack, ReviewExecution, ReviewResult } from "./types";

export interface ReviewService { review(pack: EvidencePack, options?: { signal?: AbortSignal }): Promise<ReviewExecution> }

export interface ReviewRepository {
  find(fingerprint: string): ReviewResult | null;
  save(review: ReviewResult): void;
  clear(): void;
}

const REVIEW_CACHE_KEY = "zxlab.risk.review-cache.v1";
const MAX_CACHED_REVIEWS = 5;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

export async function fingerprintEvidencePack(pack: EvidencePack): Promise<string> {
  const semantic = {
    reliable: pack.reliable,
    warnings: pack.warnings,
    evidence: pack.evidence.map(({ id, type, title, source, payload }) => ({ id, type, title, source, payload })).sort((a, b) => a.id.localeCompare(b.id)),
    metrics: pack.metrics.map(({ id, label, value, reliable, calculation, evidenceIds }) => ({ id, label, value, reliable, calculation, evidenceIds })),
    events: pack.events.map(({ triggeredAt: _triggeredAt, ...event }) => event),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(semantic)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function isReviewResult(value: unknown): value is ReviewResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReviewResult>;
  return (item.mode === "mock" || item.mode === "llm")
    && typeof item.generatedAt === "string"
    && typeof item.evidencePackFingerprint === "string"
    && typeof item.summary === "string"
    && Array.isArray(item.mainRisks) && item.mainRisks.every((entry) => entry && typeof entry.id === "string")
    && Array.isArray(item.planViolations) && item.planViolations.every((entry) => entry && typeof entry.id === "string")
    && Array.isArray(item.operationReview) && item.operationReview.every((entry) => entry && typeof entry.id === "string")
    && Array.isArray(item.counterfactuals)
    && Array.isArray(item.unknowns)
    && Array.isArray(item.questionsForUser)
    && Array.isArray(item.limitations);
}

function isReviewExecution(value: unknown): value is ReviewExecution {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReviewExecution>;
  return ["pending", "success", "partial", "failed"].includes(String(item.status))
    && isReviewResult(item.result)
    && typeof item.provider === "string"
    && typeof item.model === "string"
    && Array.isArray(item.fallbackPath)
    && typeof item.promptVersion === "string"
    && ["valid", "partial", "failed"].includes(String(item.schemaValidation))
    && Array.isArray(item.warnings)
    && Array.isArray(item.errors);
}

export class LocalReviewRepository implements ReviewRepository {
  constructor(private readonly storage: Storage) {}
  find(fingerprint: string): ReviewResult | null { return this.read().find((item) => item.mode === "llm" && item.evidencePackFingerprint === fingerprint) ?? null; }
  save(review: ReviewResult): void {
    if (review.mode !== "llm") return;
    const next = [review, ...this.read().filter((item) => item.evidencePackFingerprint !== review.evidencePackFingerprint)].slice(0, MAX_CACHED_REVIEWS);
    this.storage.setItem(REVIEW_CACHE_KEY, JSON.stringify(next));
  }
  clear(): void { this.storage.removeItem(REVIEW_CACHE_KEY); }
  private read(): ReviewResult[] {
    try {
      const parsed = JSON.parse(this.storage.getItem(REVIEW_CACHE_KEY) ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter(isReviewResult) : [];
    } catch { return []; }
  }
}

export class ApiReviewError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = "ApiReviewError"; }
}

export class ApiReviewService implements ReviewService {
  constructor(private readonly endpoint = "/api/risk/review", private readonly fetcher: typeof fetch = fetch) {}
  async review(pack: EvidencePack, options: { signal?: AbortSignal } = {}): Promise<ReviewExecution> {
    const response = await this.fetcher.call(globalThis, this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ evidencePack: pack }),
      credentials: "same-origin",
      signal: options.signal,
    });
    const raw = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(raw) as unknown; }
    catch { throw new ApiReviewError("INVALID_RESPONSE", "复盘服务返回了无法解析的响应。"); }
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const requestId = typeof root?.requestId === "string" ? root.requestId : undefined;
    if (!response.ok || root?.ok !== true || !isReviewExecution(root.data)) {
      const error = root?.error && typeof root.error === "object" ? root.error as Record<string, unknown> : null;
      throw new ApiReviewError(typeof error?.code === "string" ? error.code : `HTTP_${response.status}`, typeof error?.message === "string" ? error.message : "真实复盘暂不可用。", requestId);
    }
    return root.data;
  }
}

export class MockReviewService implements ReviewService {
  constructor(private readonly fallbackReason?: string) {}
  async review(pack: EvidencePack): Promise<ReviewExecution> {
    const has = (rule: string) => pack.events.some((item) => item.ruleId === rule);
    const matching = (rule: string) => pack.events.filter((item) => item.ruleId === rule);
    const mainRisks = pack.events.filter((item) => ["portfolio.max_effective_exposure", "portfolio.max_theme_concentration", "position.max_weight", "data_quality.quote_stale", "data_quality.position_unreconciled"].includes(item.ruleId)).map((item) => ({ id: `review:risk:${item.id}`, title: item.title, explanation: item.message, severity: item.severity, evidenceIds: item.evidenceIds }));
    const planViolations = matching("plan.max_position").map((item) => ({ id: `review:plan:${item.id}`, title: item.title, detail: item.message, evidenceIds: item.evidenceIds }));
    const facts = [
      has("portfolio.max_effective_exposure") ? "有效敞口超过规则上限" : null,
      has("portfolio.max_theme_concentration") ? "主题风险出现集中" : null,
      has("position.max_weight") ? "存在单标的仓位超限" : null,
      has("data_quality.quote_stale") ? "盘中行情过期使估值只能作为警示" : null,
      has("data_quality.position_unreconciled") ? "持仓尚未完成券商对账" : null,
    ].filter(Boolean);
    const result: ReviewResult = {
      mode: "mock",
      generatedAt: new Date().toISOString(),
      evidencePackFingerprint: await fingerprintEvidencePack(pack),
      ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
      summary: facts.length ? `本轮 Evidence Pack 显示：${facts.join("；")}。复盘只引用本轮账本、报价、规则与对账证据。` : "本轮 Evidence Pack 未触发重点风险规则，但仍应核对交易与行情完整性。",
      mainRisks,
      planViolations,
      operationReview: pack.events.filter((item) => item.ruleId === "position.max_weight").map((item) => ({ id: `review:operation:${item.id}`, category: "仓位纪律", observation: item.message, evidenceIds: item.evidenceIds })),
      counterfactuals: ["如果不持有超出计划的仓位，有效敞口会下降多少？", "如果只使用新鲜且已对账的数据，当前结论是否仍然成立？"],
      unknowns: pack.warnings,
      questionsForUser: ["券商当前数量是否已与交易账本逐项核对？"],
      limitations: [this.fallbackReason ? `真实 LLM 不可用，已降级：${this.fallbackReason}` : "当前为 Mock Review；文本由 Evidence Pack 中的事件组合生成，不调用真实 LLM。", ...(!pack.reliable ? ["数据质量警告存在，复盘不得视为完全可靠。"] : [])],
    };
    return {
      status: this.fallbackReason ? "partial" : "success",
      result,
      provider: "mock",
      model: "evidence-template-v1",
      fallbackPath: this.fallbackReason ? [this.fallbackReason, "mock/evidence-template-v1"] : ["mock/evidence-template-v1"],
      requestDurationMs: 0,
      inputTokens: null,
      outputTokens: null,
      estimatedCost: 0,
      promptVersion: "portfolio-review.mock.v1",
      schemaValidation: this.fallbackReason ? "failed" : "valid",
      retryCount: 0,
      warnings: this.fallbackReason ? [`真实 LLM 已降级：${this.fallbackReason}`] : [],
      errors: this.fallbackReason ? [this.fallbackReason] : [],
    };
  }
}
