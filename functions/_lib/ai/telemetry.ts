import type { AIErrorCode, AIUsage, LLMCallContext } from "../../../src/lib/ai/types.ts";
import type { ModelCandidate } from "./config.ts";

/** Minimal D1 contract so Pages Functions do not need generated Worker types. */
export interface LLMUsageDatabase {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }>; first<T>(): Promise<T | null> } };
}

export type LLMUsageStatus = "success" | "error" | "timeout" | "cancelled";

export interface LLMUsageEvent {
  id: string; requestId: string; createdAt: string; source: string; operation?: string;
  provider: string; model: string; inputTokens?: number; outputTokens?: number;
  cachedInputTokens?: number; reasoningTokens?: number; totalTokens?: number;
  estimatedCostUsd?: number; latencyMs: number; status: LLMUsageStatus;
  errorType?: string; errorCode?: string; fallbackDepth: number;
  fallbackFromProvider?: string; fallbackFromModel?: string; isStreaming: boolean;
}

export const LLM_PRICING_UPDATED_AT = "unconfigured";
export type ModelPricing = { inputPerMillion?: number; outputPerMillion?: number; cachedInputPerMillion?: number };
/** Populate only with provider-confirmed prices; unknown models must remain null. */
const modelPricing: Record<string, ModelPricing> = {};

export function estimateLLMCost(input: Pick<LLMUsageEvent, "provider" | "model" | "inputTokens" | "outputTokens" | "cachedInputTokens">): number | undefined {
  const pricing = modelPricing[`${input.provider}:${input.model}`];
  if (!pricing || (pricing.inputPerMillion === undefined && pricing.outputPerMillion === undefined && pricing.cachedInputPerMillion === undefined)) return undefined;
  const cost = (input.inputTokens ?? 0) * (pricing.inputPerMillion ?? 0) / 1_000_000
    + (input.outputTokens ?? 0) * (pricing.outputPerMillion ?? 0) / 1_000_000
    + (input.cachedInputTokens ?? 0) * (pricing.cachedInputPerMillion ?? 0) / 1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}

export function normalizeUsage(value: AIUsage | undefined): AIUsage | undefined {
  if (!value) return undefined;
  const valid = (token: number | undefined) => typeof token === "number" && Number.isFinite(token) && token >= 0 ? Math.trunc(token) : undefined;
  const inputTokens = valid(value.inputTokens); const outputTokens = valid(value.outputTokens);
  const cachedInputTokens = valid(value.cachedInputTokens); const reasoningTokens = valid(value.reasoningTokens);
  const totalTokens = valid(value.totalTokens) ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  return inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && reasoningTokens === undefined && totalTokens === undefined
    ? undefined : { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(reasoningTokens === undefined ? {} : { reasoningTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
}

export function resolveCallContext(task: string, context: LLMCallContext | undefined): Required<Pick<LLMCallContext, "source">> & Pick<LLMCallContext, "operation"> {
  const source = context?.source?.trim() || (task.startsWith("signal-") ? "signal" : (task.startsWith("risk-") || task === "portfolio-review") ? "risk" : task.startsWith("notes-") ? "notes" : task.startsWith("chat-") ? "chat" : "unknown");
  return { source: source.slice(0, 48), ...(context?.operation ? { operation: context.operation.slice(0, 64) } : {}) };
}

export function telemetryStatus(error?: AIErrorCode): LLMUsageStatus {
  if (error === "TIMEOUT") return "timeout";
  return "error";
}

export function createUsageEvent(input: {
  requestId: string; context: ReturnType<typeof resolveCallContext>; candidate: ModelCandidate; previousCandidate?: ModelCandidate;
  fallbackDepth: number; latencyMs: number; status: LLMUsageStatus; usage?: AIUsage; errorCode?: AIErrorCode; isStreaming?: boolean;
}): LLMUsageEvent {
  const usage = normalizeUsage(input.usage);
  const event = {
    id: crypto.randomUUID(), requestId: input.requestId, createdAt: new Date().toISOString(), source: input.context.source,
    ...(input.context.operation ? { operation: input.context.operation } : {}), provider: input.candidate.provider, model: input.candidate.model,
    inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedInputTokens: usage?.cachedInputTokens,
    reasoningTokens: usage?.reasoningTokens, totalTokens: usage?.totalTokens, latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    status: input.status, ...(input.errorCode ? { errorType: errorType(input.errorCode), errorCode: input.errorCode } : {}),
    fallbackDepth: input.fallbackDepth, ...(input.previousCandidate ? { fallbackFromProvider: input.previousCandidate.provider, fallbackFromModel: input.previousCandidate.model } : {}), isStreaming: input.isStreaming ?? false,
  } satisfies Omit<LLMUsageEvent, "estimatedCostUsd">;
  return { ...event, estimatedCostUsd: estimateLLMCost(event) };
}

function errorType(code: AIErrorCode): string {
  if (code === "TIMEOUT") return "timeout";
  if (code === "RATE_LIMITED") return "rate_limit";
  if (code === "UNAUTHORIZED") return "auth";
  if (["MODEL_UNAVAILABLE", "QUOTA_EXCEEDED"].includes(code)) return "provider_unavailable";
  if (["INVALID_INPUT", "CONTEXT_TOO_LONG"].includes(code)) return "invalid_request";
  if (code === "NETWORK_ERROR") return "network";
  return "unknown";
}

/** Best effort only: failures are intentionally swallowed by the caller. */
export async function recordLLMUsage(db: LLMUsageDatabase | undefined, event: LLMUsageEvent): Promise<void> {
  if (!db) return;
  await db.prepare(`INSERT INTO llm_usage_events (id, request_id, created_at, source, operation, provider, model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens, estimated_cost_usd, latency_ms, status, error_type, error_code, fallback_depth, fallback_from_provider, fallback_from_model, is_streaming)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id, event.requestId, event.createdAt, event.source, event.operation ?? null, event.provider, event.model,
      event.inputTokens ?? null, event.outputTokens ?? null, event.cachedInputTokens ?? null, event.reasoningTokens ?? null, event.totalTokens ?? null,
      event.estimatedCostUsd ?? null, event.latencyMs, event.status, event.errorType ?? null, event.errorCode ?? null, event.fallbackDepth,
      event.fallbackFromProvider ?? null, event.fallbackFromModel ?? null, event.isStreaming ? 1 : 0).run();
}
