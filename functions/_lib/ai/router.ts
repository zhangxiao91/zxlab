import type { GenerateAIInput, GenerateAIResult } from "../../../src/lib/ai/types.ts";
import { getDefaultModelChain, type AIEnv, type ModelCandidate } from "./config.ts";
import { AIError, asAIError } from "./errors.ts";
import { parseStructuredOutput } from "./json.ts";
import { consoleAILogger, type AILogger, usageFields } from "./logger.ts";
import { DeepSeekCompatibleAdapter } from "./providers/deepseek.ts";
import { OpenAICompatibleAdapter } from "./providers/openai-compatible.ts";
import type { AIProviderAdapter } from "./providers/types.ts";
import { resolveTaskPolicy } from "./task-policies.ts";
import { createUsageEvent, recordLLMUsage, resolveCallContext, telemetryStatus, type LLMUsageDatabase } from "./telemetry.ts";

type AdapterMap = Record<ModelCandidate["adapter"], AIProviderAdapter>;

export interface AIGatewayOptions {
  env?: AIEnv;
  requestId?: string;
  fetcher?: typeof fetch;
  logger?: AILogger;
  candidates?: ModelCandidate[];
  adapters?: AdapterMap;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitterMs?: () => number;
  telemetryDb?: LLMUsageDatabase;
  /** Cloudflare ExecutionContext.waitUntil-compatible scheduler. */
  scheduleTelemetry?: (task: Promise<unknown>) => void;
  signal?: AbortSignal;
}

export interface AIStreamObserver {
  attempt(event: { provider: string; model: string; fallbackIndex: number; attempt: number }): Promise<void>;
  delta(text: string): Promise<void>;
  reset(reason: "retry" | "fallback"): Promise<void>;
}

const defaultAdapters: AdapterMap = {
  "openai-compatible": new OpenAICompatibleAdapter(),
  "deepseek-compatible": new DeepSeekCompatibleAdapter(),
};

function secureJitterMs(): number {
  const value = new Uint16Array(1);
  crypto.getRandomValues(value);
  return value[0] % 101;
}

function withAttempts(error: AIError, attempts: number): AIError {
  return new AIError(error.code, {
    cause: error,
    statusCode: error.statusCode,
    retryable: error.retryable,
    fallbackAllowed: error.fallbackAllowed,
    attempts,
    safeMessage: error.safeMessage,
  });
}

export async function generateAI(input: GenerateAIInput, options: AIGatewayOptions = {}): Promise<GenerateAIResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitterMs = options.jitterMs ?? secureJitterMs;
  const logger = options.logger ?? consoleAILogger;
  const requestId = options.requestId ?? crypto.randomUUID();
  const startedAt = now();
  const policy = resolveTaskPolicy(input);
  const deadline = startedAt + policy.totalBudgetMs;
  const effectiveInput: GenerateAIInput = {
    ...input,
    temperature: policy.temperature,
    maxOutputTokens: policy.maxOutputTokens,
    responseFormat: input.responseFormat ?? { type: "text" },
  };
  const inputChars = input.messages.reduce((sum, message) => sum + message.content.length, 0);
  const callContext = resolveCallContext(input.task, input.context);
  let candidates: ModelCandidate[] = [];
  const recordAttempt = (candidate: ModelCandidate, fallbackIndex: number, durationMs: number, status: "success" | "error" | "timeout" | "cancelled", usage?: GenerateAIResult["usage"], errorCode?: AIError["code"]) => {
    const event = createUsageEvent({ requestId, context: callContext, candidate, previousCandidate: fallbackIndex > 0 ? candidates?.[fallbackIndex - 1] : undefined,
      fallbackDepth: fallbackIndex, latencyMs: durationMs, status, usage, errorCode });
    const task = recordLLMUsage(options.telemetryDb, event).catch((error) => console.warn("ai.gateway.telemetry_failed", requestId, error instanceof Error ? error.name : "unknown"));
    if (options.scheduleTelemetry) options.scheduleTelemetry(task); else void task;
  };
  let attempts = 0;
  let lastError: AIError | undefined;

  try {
    candidates = options.candidates ?? getDefaultModelChain(options.env ?? {});
    const adapters = options.adapters ?? defaultAdapters;
    for (let fallbackIndex = 0; fallbackIndex < candidates.length; fallbackIndex += 1) {
      const candidate = candidates[fallbackIndex];
      const adapter = adapters[candidate.adapter];
      if (!adapter) throw new AIError("MISSING_CONFIGURATION");

      for (let retryIndex = 0; retryIndex < 2; retryIndex += 1) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw new AIError("TIMEOUT", { attempts });
        attempts += 1;
        const attemptStartedAt = now();
        let attemptStatusCode: number | undefined;
        try {
          const providerResult = await adapter.generate(candidate, effectiveInput, {
            requestId,
            timeoutMs: Math.min(policy.timeoutMs, remainingMs),
            fetcher: options.fetcher ?? fetch,
            signal: options.signal,
          });
          attemptStatusCode = providerResult.statusCode;
          const json = effectiveInput.responseFormat?.type === "json" ? parseStructuredOutput(providerResult.text) : undefined;
          const durationMs = Math.max(0, now() - attemptStartedAt);
          logger.write({
            event: "ai.gateway.attempt", requestId, task: input.task, candidateId: candidate.id,
            attempt: retryIndex + 1, durationMs, success: true, statusCode: providerResult.statusCode,
          });
          recordAttempt(candidate, fallbackIndex, durationMs, "success", providerResult.usage);
          const result: GenerateAIResult = {
            text: json === undefined ? providerResult.text : JSON.stringify(json),
            ...(json === undefined ? {} : { json }),
            provider: candidate.provider,
            model: candidate.model,
            fallbackIndex,
            attempts,
            latencyMs: Math.max(0, now() - startedAt),
            usage: providerResult.usage,
          };
          logger.write({
            event: "ai.gateway.request", requestId, task: input.task, success: true,
            selectedCandidate: candidate.id, selectedProvider: candidate.provider, selectedModel: candidate.model,
            fallbackIndex, attempts, latencyMs: result.latencyMs, ...usageFields(result.usage),
            messageCount: input.messages.length, inputChars,
          });
          return result;
        } catch (cause) {
          const error = asAIError(cause);
          lastError = error;
          logger.write({
            event: "ai.gateway.attempt", requestId, task: input.task, candidateId: candidate.id,
            attempt: retryIndex + 1, durationMs: Math.max(0, now() - attemptStartedAt), success: false,
            statusCode: error.statusCode ?? attemptStatusCode, normalizedErrorCode: error.code,
          });
          recordAttempt(candidate, fallbackIndex, Math.max(0, now() - attemptStartedAt), telemetryStatus(error.code), undefined, error.code);
          if (error.retryable && retryIndex === 0) {
            const delayMs = 250 + jitterMs();
            if (deadline - now() <= delayMs) throw new AIError("TIMEOUT", { cause: error, attempts });
            await sleep(delayMs);
            continue;
          }
          if (!error.fallbackAllowed) throw withAttempts(error, attempts);
          break;
        }
      }
    }
    throw new AIError("ALL_CANDIDATES_FAILED", { cause: lastError, attempts });
  } catch (cause) {
    const error = withAttempts(asAIError(cause), attempts);
    logger.write({
      event: "ai.gateway.request", requestId, task: input.task, success: false, attempts,
      latencyMs: Math.max(0, now() - startedAt), errorCode: error.code,
      messageCount: input.messages.length, inputChars,
    });
    throw error;
  }
}

export async function streamAI(
  input: GenerateAIInput,
  observer: AIStreamObserver,
  options: AIGatewayOptions = {},
): Promise<GenerateAIResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitterMs = options.jitterMs ?? secureJitterMs;
  const logger = options.logger ?? consoleAILogger;
  const requestId = options.requestId ?? crypto.randomUUID();
  const startedAt = now();
  const policy = resolveTaskPolicy(input);
  const deadline = startedAt + policy.totalBudgetMs;
  const effectiveInput: GenerateAIInput = {
    ...input,
    temperature: policy.temperature,
    maxOutputTokens: policy.maxOutputTokens,
    responseFormat: input.responseFormat ?? { type: "text" },
  };
  const inputChars = input.messages.reduce((sum, message) => sum + message.content.length, 0);
  const callContext = resolveCallContext(input.task, input.context);
  let candidates: ModelCandidate[] = [];
  let attempts = 0;
  let lastError: AIError | undefined;

  const recordAttempt = (candidate: ModelCandidate, fallbackIndex: number, durationMs: number, status: "success" | "error" | "timeout" | "cancelled", usage?: GenerateAIResult["usage"], errorCode?: AIError["code"]) => {
    const event = createUsageEvent({ requestId, context: callContext, candidate, previousCandidate: fallbackIndex > 0 ? candidates[fallbackIndex - 1] : undefined,
      fallbackDepth: fallbackIndex, latencyMs: durationMs, status, usage, errorCode, isStreaming: true });
    const task = recordLLMUsage(options.telemetryDb, event).catch((error) => console.warn("ai.gateway.telemetry_failed", requestId, error instanceof Error ? error.name : "unknown"));
    if (options.scheduleTelemetry) options.scheduleTelemetry(task); else void task;
  };

  try {
    candidates = options.candidates ?? getDefaultModelChain(options.env ?? {});
    const adapters = options.adapters ?? defaultAdapters;
    for (let fallbackIndex = 0; fallbackIndex < candidates.length; fallbackIndex += 1) {
      const candidate = candidates[fallbackIndex];
      const adapter = adapters[candidate.adapter];
      if (!adapter) throw new AIError("MISSING_CONFIGURATION");

      for (let retryIndex = 0; retryIndex < 2; retryIndex += 1) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw new AIError("TIMEOUT", { attempts });
        attempts += 1;
        const attemptStartedAt = now();
        let attemptStatusCode: number | undefined;
        await observer.attempt({ provider: candidate.provider, model: candidate.model, fallbackIndex, attempt: retryIndex + 1 });
        try {
          const providerResult = await adapter.stream(candidate, effectiveInput, {
            requestId,
            timeoutMs: Math.min(policy.timeoutMs, remainingMs),
            fetcher: options.fetcher ?? fetch,
            signal: options.signal,
          }, observer.delta);
          attemptStatusCode = providerResult.statusCode;
          const json = effectiveInput.responseFormat?.type === "json" ? parseStructuredOutput(providerResult.text) : undefined;
          const durationMs = Math.max(0, now() - attemptStartedAt);
          logger.write({
            event: "ai.gateway.attempt", requestId, task: input.task, candidateId: candidate.id,
            attempt: retryIndex + 1, durationMs, success: true, statusCode: providerResult.statusCode,
          });
          recordAttempt(candidate, fallbackIndex, durationMs, "success", providerResult.usage);
          const result: GenerateAIResult = {
            text: json === undefined ? providerResult.text : JSON.stringify(json),
            ...(json === undefined ? {} : { json }),
            provider: candidate.provider,
            model: candidate.model,
            fallbackIndex,
            attempts,
            latencyMs: Math.max(0, now() - startedAt),
            usage: providerResult.usage,
          };
          logger.write({
            event: "ai.gateway.request", requestId, task: input.task, success: true,
            selectedCandidate: candidate.id, selectedProvider: candidate.provider, selectedModel: candidate.model,
            fallbackIndex, attempts, latencyMs: result.latencyMs, ...usageFields(result.usage),
            messageCount: input.messages.length, inputChars,
          });
          return result;
        } catch (cause) {
          const error = asAIError(cause);
          lastError = error;
          logger.write({
            event: "ai.gateway.attempt", requestId, task: input.task, candidateId: candidate.id,
            attempt: retryIndex + 1, durationMs: Math.max(0, now() - attemptStartedAt), success: false,
            statusCode: error.statusCode ?? attemptStatusCode, normalizedErrorCode: error.code,
          });
          recordAttempt(candidate, fallbackIndex, Math.max(0, now() - attemptStartedAt), telemetryStatus(error.code), undefined, error.code);
          if (error.retryable && retryIndex === 0) {
            await observer.reset("retry");
            const delayMs = 250 + jitterMs();
            if (deadline - now() <= delayMs) throw new AIError("TIMEOUT", { cause: error, attempts });
            await sleep(delayMs);
            continue;
          }
          if (!error.fallbackAllowed) throw withAttempts(error, attempts);
          if (fallbackIndex < candidates.length - 1) await observer.reset("fallback");
          break;
        }
      }
    }
    throw new AIError("ALL_CANDIDATES_FAILED", { cause: lastError, attempts });
  } catch (cause) {
    const error = withAttempts(asAIError(cause), attempts);
    logger.write({
      event: "ai.gateway.request", requestId, task: input.task, success: false, attempts,
      latencyMs: Math.max(0, now() - startedAt), errorCode: error.code,
      messageCount: input.messages.length, inputChars,
    });
    throw error;
  }
}
