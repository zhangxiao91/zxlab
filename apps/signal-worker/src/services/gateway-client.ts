import { SignalValidationError } from "@zxlab/signal-schema";

const MAX_GATEWAY_RESPONSE_BYTES = 512 * 1024;
const STREAM_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = 180_000;

export interface GatewaySuccess {
  ok: true;
  data: {
    text: string;
    json?: unknown;
    provider: string;
    model: string;
    fallbackIndex: number;
    latencyMs: number;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  };
  requestId: string;
}

export class GatewayRequestError extends Error {
  constructor(readonly failureCode: string, message: string, readonly status = 502) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

class GatewayStreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayStreamUnavailableError";
  }
}

class GatewayStreamProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayStreamProtocolError";
  }
}

function shouldFallbackToGenerate(error: unknown, apiUrl: string): boolean {
  if (error instanceof GatewayStreamUnavailableError || error instanceof GatewayStreamProtocolError) return true;
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof TypeError && streamEndpoint(apiUrl) !== generateEndpoint(apiUrl)) return true;
  return false;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function gatewaySuccess(value: unknown): GatewaySuccess {
  const root = object(value);
  const data = object(root?.data);
  if (root?.ok !== true || !data || typeof root.requestId !== "string"
    || typeof data.text !== "string" || typeof data.provider !== "string" || typeof data.model !== "string"
    || typeof data.fallbackIndex !== "number" || typeof data.latencyMs !== "number") {
    throw new SignalValidationError("Gateway response did not match the success contract");
  }
  return value as GatewaySuccess;
}

export function responseValue(result: GatewaySuccess): unknown {
  if (result.data.json !== undefined) return result.data.json;
  const cleaned = result.data.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as unknown;
}

function streamEndpoint(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.pathname.endsWith("/api/ai/generate")) url.pathname = url.pathname.replace(/\/api\/ai\/generate$/, "/api/ai/stream");
  else if (url.pathname.endsWith("/generate")) url.pathname = url.pathname.replace(/\/generate$/, "/stream");
  return url.toString();
}

function generateEndpoint(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.pathname.endsWith("/api/ai/stream")) url.pathname = url.pathname.replace(/\/api\/ai\/stream$/, "/api/ai/generate");
  else if (url.pathname.endsWith("/stream")) url.pathname = url.pathname.replace(/\/stream$/, "/generate");
  return url.toString();
}

function gatewayHeaders(token: string, invocationId: string, accept: "application/json" | "text/event-stream"): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: accept,
    "X-Request-Id": invocationId,
  };
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_GATEWAY_RESPONSE_BYTES) {
    throw new SignalValidationError("Gateway response was too large");
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_GATEWAY_RESPONSE_BYTES) {
    throw new SignalValidationError("Gateway response was too large");
  }
  return raw;
}

function gatewayErrorFromPayload(payload: unknown, status: number): GatewayRequestError {
  const root = object(payload);
  const error = object(root?.error);
  const code = typeof error?.code === "string" ? error.code : `HTTP_${status}`;
  return new GatewayRequestError(`GATEWAY_${status}_${code}`.slice(0, 120), `Project AI gateway failed with ${code}`, 502);
}

async function requestGenerate(params: {
  fetcher: typeof fetch;
  apiUrl: string;
  token: string;
  invocationId: string;
  body: unknown;
}): Promise<GatewaySuccess> {
  const response = await params.fetcher(generateEndpoint(params.apiUrl), {
    method: "POST",
    headers: gatewayHeaders(params.token, params.invocationId, "application/json"),
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  const raw = await readBoundedText(response);
  let payload: unknown;
  try { payload = JSON.parse(raw) as unknown; }
  catch (cause) { throw new SignalValidationError(`Gateway returned invalid JSON: ${cause instanceof Error ? cause.message : "parse failure"}`); }
  if (!response.ok) throw gatewayErrorFromPayload(payload, response.status);
  return gatewaySuccess(payload);
}

function streamEvent(value: unknown): { type: string; requestId: string; text?: unknown; data?: unknown; error?: unknown } {
  const event = object(value);
  if (!event || typeof event.type !== "string" || typeof event.requestId !== "string"
    || !new Set(["start", "attempt", "delta", "reset", "done", "error"]).has(event.type)) {
    throw new GatewayStreamProtocolError("Gateway stream returned an invalid event");
  }
  return event as { type: string; requestId: string; text?: unknown; data?: unknown; error?: unknown };
}

async function requestStream(params: {
  fetcher: typeof fetch;
  apiUrl: string;
  token: string;
  invocationId: string;
  body: unknown;
  onDelta?: (text: string) => void;
  onReset?: () => void;
}): Promise<GatewaySuccess> {
  const response = await params.fetcher(streamEndpoint(params.apiUrl), {
    method: "POST",
    headers: gatewayHeaders(params.token, params.invocationId, "text/event-stream"),
    body: JSON.stringify(params.body),
    signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    if ([404, 405, 406, 415, 501].includes(response.status)) {
      throw new GatewayStreamUnavailableError(`Gateway stream endpoint returned HTTP ${response.status}`);
    }
    const raw = await readBoundedText(response);
    let payload: unknown;
    try { payload = JSON.parse(raw) as unknown; }
    catch { payload = undefined; }
    throw gatewayErrorFromPayload(payload, response.status);
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    throw new GatewayStreamUnavailableError("Gateway stream endpoint did not return text/event-stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let dataLines: string[] = [];
  let sawEvent = false;

  const parseData = (): GatewaySuccess | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    sawEvent = true;
    let event: ReturnType<typeof streamEvent>;
    try {
      event = streamEvent(JSON.parse(data) as unknown);
    } catch (cause) {
      if (cause instanceof GatewayStreamProtocolError) throw cause;
      throw new GatewayStreamProtocolError("Gateway stream returned invalid JSON", { cause });
    }
    if (event.type === "done") {
      try { return gatewaySuccess({ ok: true, data: event.data, requestId: event.requestId }); }
      catch (cause) { throw new GatewayStreamProtocolError("Gateway stream returned an invalid terminal event", { cause }); }
    }
    if (event.type === "delta") {
      if (typeof event.text !== "string") throw new GatewayStreamProtocolError("Gateway stream returned an invalid delta event");
      params.onDelta?.(event.text);
      return undefined;
    }
    if (event.type === "reset") {
      params.onReset?.();
      return undefined;
    }
    if (event.type === "error") {
      const error = object(event.error);
      const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
      throw new GatewayRequestError(`GATEWAY_STREAM_${code}`.slice(0, 120), `Project AI gateway failed with ${code}`, 502);
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_GATEWAY_RESPONSE_BYTES) throw new SignalValidationError("Gateway response was too large");
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          const result = parseData();
          if (result) return result;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    const finalLine = buffer.replace(/\r$/, "");
    if (finalLine.startsWith("data:")) dataLines.push(finalLine.slice(5).trimStart());
    const result = parseData();
    if (result) return result;
  } finally {
    reader.releaseLock();
  }

  if (!sawEvent) throw new GatewayStreamUnavailableError("Gateway stream ended before any event");
  throw new GatewayStreamProtocolError("Project AI gateway stream ended before completion");
}

export async function requestGatewayJson(params: {
  fetcher: typeof fetch;
  apiUrl: string;
  token: string;
  invocationId: string;
  body: unknown;
  onDelta?: (text: string) => void;
  onReset?: () => void;
}): Promise<GatewaySuccess> {
  try {
    return await requestStream(params);
  } catch (cause) {
    if (shouldFallbackToGenerate(cause, params.apiUrl)) {
      params.onReset?.();
      return requestGenerate(params);
    }
    throw cause;
  }
}
