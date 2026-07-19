import { SignalValidationError } from "@zxlab/signal-schema";

const MAX_GATEWAY_RESPONSE_BYTES = 512 * 1024;

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
  });
  const raw = await readBoundedText(response);
  let payload: unknown;
  try { payload = JSON.parse(raw) as unknown; }
  catch (cause) { throw new SignalValidationError(`Gateway returned invalid JSON: ${cause instanceof Error ? cause.message : "parse failure"}`); }
  if (!response.ok) throw gatewayErrorFromPayload(payload, response.status);
  return gatewaySuccess(payload);
}

function streamEvent(value: unknown): { type: string; requestId?: unknown; data?: unknown; error?: unknown } {
  const event = object(value);
  if (!event || typeof event.type !== "string") throw new SignalValidationError("Gateway stream returned an invalid event");
  return event as { type: string; requestId?: unknown; data?: unknown; error?: unknown };
}

async function requestStream(params: {
  fetcher: typeof fetch;
  apiUrl: string;
  token: string;
  invocationId: string;
  body: unknown;
}): Promise<GatewaySuccess> {
  const response = await params.fetcher(streamEndpoint(params.apiUrl), {
    method: "POST",
    headers: gatewayHeaders(params.token, params.invocationId, "text/event-stream"),
    body: JSON.stringify(params.body),
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
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
    const event = streamEvent(JSON.parse(data) as unknown);
    if (event.type === "done") return gatewaySuccess({ ok: true, data: event.data, requestId: event.requestId });
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
  throw new GatewayRequestError("GATEWAY_STREAM_INCOMPLETE", "Project AI gateway stream ended before completion", 502);
}

export async function requestGatewayJson(params: {
  fetcher: typeof fetch;
  apiUrl: string;
  token: string;
  invocationId: string;
  body: unknown;
}): Promise<GatewaySuccess> {
  try {
    return await requestStream(params);
  } catch (cause) {
    if (cause instanceof GatewayStreamUnavailableError || (cause instanceof TypeError && streamEndpoint(params.apiUrl) !== generateEndpoint(params.apiUrl))) {
      return requestGenerate(params);
    }
    throw cause;
  }
}
