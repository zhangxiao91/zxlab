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
  const inputTokens = typeof value.prompt_tokens === "number" ? value.prompt_tokens : typeof value.input_tokens === "number" ? value.input_tokens : undefined;
  const outputTokens = typeof value.completion_tokens === "number" ? value.completion_tokens : typeof value.output_tokens === "number" ? value.output_tokens : undefined;
  const details = record(value.prompt_tokens_details) ?? record(value.input_tokens_details);
  const outputDetails = record(value.completion_tokens_details) ?? record(value.output_tokens_details);
  const cachedInputTokens = typeof value.cached_tokens === "number" ? value.cached_tokens
    : typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens
      : typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined;
  const reasoningTokens = typeof value.reasoning_tokens === "number" ? value.reasoning_tokens
    : typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined;
  const totalTokens = typeof value.total_tokens === "number" ? value.total_tokens : undefined;
  return inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && reasoningTokens === undefined && totalTokens === undefined
    ? undefined
    : {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
    };
}

function requestBody(candidate: ModelCandidate, input: GenerateAIInput, streaming: boolean): string {
  return JSON.stringify({
    model: candidate.model,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.maxOutputTokens,
    ...(input.responseFormat?.type === "json" ? { response_format: { type: "json_object" } } : {}),
    ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
}

function bindExternalAbort(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function readOpenAIStream(
  response: Response,
  onDelta: (text: string) => Promise<void>,
): Promise<Pick<ProviderGenerateResult, "text" | "usage">> {
  if (!response.body) throw new AIError("INVALID_PROVIDER_RESPONSE", { statusCode: response.status, fallbackAllowed: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let text = "";
  let streamUsage: AIUsage | undefined;
  let dataLines: string[] = [];

  const consumeEvent = async (): Promise<void> => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    let value: unknown;
    try { value = JSON.parse(data) as unknown; }
    catch (cause) { throw new AIError("INVALID_PROVIDER_RESPONSE", { cause, statusCode: response.status, fallbackAllowed: true }); }
    const root = record(value);
    if (!root) throw new AIError("INVALID_PROVIDER_RESPONSE", { statusCode: response.status, fallbackAllowed: true });
    streamUsage = usage(root) ?? streamUsage;
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const delta = record(record(choices[0])?.delta);
    const content = delta?.content;
    if (typeof content === "string" && content.length > 0) {
      text += content;
      await onDelta(content);
    }
  };

  const consumeLines = async (flush: boolean): Promise<void> => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) await consumeEvent();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (flush) {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      await consumeEvent();
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AIError("INVALID_PROVIDER_RESPONSE", { statusCode: response.status, fallbackAllowed: true });
      }
      buffer += decoder.decode(value, { stream: true });
      await consumeLines(false);
    }
    buffer += decoder.decode();
    await consumeLines(true);
  } finally {
    reader.releaseLock();
  }
  if (!text.trim()) throw new AIError("INVALID_PROVIDER_RESPONSE", { statusCode: response.status, fallbackAllowed: true });
  return { text: text.trim(), usage: streamUsage };
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  async generate(candidate: ModelCandidate, input: GenerateAIInput, context: RequestContext): Promise<ProviderGenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    const unbindAbort = bindExternalAbort(controller, context.signal);
    try {
      const response = await context.fetcher.call(globalThis, endpoint(candidate.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${candidate.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Request-Id": context.requestId,
        },
        body: requestBody(candidate, input, false),
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
      unbindAbort();
    }
  }

  async stream(
    candidate: ModelCandidate,
    input: GenerateAIInput,
    context: RequestContext,
    onDelta: (text: string) => Promise<void>,
  ): Promise<ProviderGenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
    const unbindAbort = bindExternalAbort(controller, context.signal);
    try {
      const response = await context.fetcher.call(globalThis, endpoint(candidate.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${candidate.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Request-Id": context.requestId,
        },
        body: requestBody(candidate, input, true),
        signal: controller.signal,
      });
      if (!response.ok) {
        const raw = await readBoundedText(response, MAX_PROVIDER_ERROR_BYTES);
        let value: unknown;
        try { value = raw ? JSON.parse(raw) as unknown : undefined; }
        catch { value = undefined; }
        throw providerHttpError(response.status, value);
      }
      const streamed = await readOpenAIStream(response, onDelta);
      return { ...streamed, statusCode: response.status };
    } catch (error) {
      throw asAIError(error);
    } finally {
      clearTimeout(timeout);
      unbindAbort();
    }
  }
}
