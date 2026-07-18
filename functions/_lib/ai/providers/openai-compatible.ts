import type { AIUsage, GenerateAIInput } from "../../../../src/lib/ai/types.ts";
import type { ModelCandidate } from "../config.ts";
import { AIError, asAIError } from "../errors.ts";
import type { AIProviderAdapter, ProviderGenerateResult, RequestContext } from "./types.ts";

const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AIError("INVALID_PROVIDER_RESPONSE", { fallbackAllowed: true });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function errorText(value: unknown): string {
  const root = record(value);
  const error = record(root?.error);
  return [error?.code, error?.type, error?.message, root?.message].filter((item) => typeof item === "string").join(" ").toLowerCase();
}

function providerHttpError(status: number, value: unknown): AIError {
  const detail = errorText(value);
  if (/context|maximum.*token|too many tokens|context_length/.test(detail)) {
    return new AIError("CONTEXT_TOO_LONG", { statusCode: status });
  }
  if (/quota|insufficient[_ ]quota|balance|credit|billing/.test(detail)) {
    return new AIError("QUOTA_EXCEEDED", { statusCode: status, fallbackAllowed: true });
  }
  if (/model.*(unavailable|overloaded|not found)|capacity|temporarily unavailable/.test(detail)) {
    return new AIError("MODEL_UNAVAILABLE", { statusCode: status, fallbackAllowed: true });
  }
  if (status === 429) return new AIError("RATE_LIMITED", { statusCode: status, retryable: true, fallbackAllowed: true });
  if ([502, 503, 504].includes(status)) return new AIError("MODEL_UNAVAILABLE", { statusCode: status, retryable: true, fallbackAllowed: true });
  if (status === 500) return new AIError("MODEL_UNAVAILABLE", { statusCode: status, fallbackAllowed: true });
  return new AIError("UNKNOWN", { statusCode: status });
}

function endpoint(baseUrl: string): string {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
}

function usage(root: Record<string, unknown>): AIUsage | undefined {
  const value = record(root.usage);
  if (!value) return undefined;
  const inputTokens = typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined;
  const outputTokens = typeof value.completion_tokens === "number" ? value.completion_tokens : undefined;
  const totalTokens = typeof value.total_tokens === "number" ? value.total_tokens : undefined;
  return inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
    ? undefined
    : { inputTokens, outputTokens, totalTokens };
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  async generate(candidate: ModelCandidate, input: GenerateAIInput, context: RequestContext): Promise<ProviderGenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    try {
      const response = await context.fetcher.call(globalThis, endpoint(candidate.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${candidate.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Request-Id": context.requestId,
        },
        body: JSON.stringify({
          model: candidate.model,
          messages: input.messages,
          temperature: input.temperature,
          max_tokens: input.maxOutputTokens,
          ...(input.responseFormat?.type === "json" ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      const raw = await readBoundedText(response, response.ok ? MAX_PROVIDER_RESPONSE_BYTES : MAX_PROVIDER_ERROR_BYTES);
      let value: unknown;
      try { value = raw ? JSON.parse(raw) as unknown : undefined; } catch (cause) {
        throw new AIError("INVALID_PROVIDER_RESPONSE", { cause, statusCode: response.status, fallbackAllowed: true });
      }
      if (!response.ok) throw providerHttpError(response.status, value);
      const root = record(value);
      const choices = Array.isArray(root?.choices) ? root.choices : [];
      const message = record(record(choices[0])?.message);
      const content = message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new AIError("INVALID_PROVIDER_RESPONSE", { statusCode: response.status, fallbackAllowed: true });
      }
      return { text: content.trim(), usage: root ? usage(root) : undefined, statusCode: response.status };
    } catch (error) {
      throw asAIError(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
