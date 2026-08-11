import { createMockAnnotationResponse, createMockBriefing, updateMockMemoryCandidate } from "./mock";
import type {
  AnnotationInput,
  AnnotationResponse,
  BriefingPreviewState,
  CreateWatchRequest,
  DailyBriefing,
  MemoriesResponse,
  MemoryCandidate,
  MemoryScope,
  SignalErrorResponse,
  WatchDossier,
  WatchResponse,
  WatchesResponse,
} from "./types";

export type AnnotationStreamEvent =
  | { type: "start" }
  | { type: "reply_delta"; text: string }
  | { type: "reply_reset" }
  | { type: "reply"; annotation: AnnotationResponse["annotation"]; reply: AnnotationResponse["reply"] }
  | { type: "memory"; memoryCandidate?: MemoryCandidate }
  | { type: "done"; response: AnnotationResponse }
  | { type: "error"; error: { message: string } };

const configuredMode = import.meta.env.PUBLIC_SIGNAL_DATA_MODE;
const dataMode: "api" | "mock" = configuredMode === "api" || configuredMode === "mock"
  ? configuredMode
  : import.meta.env.DEV ? "mock" : "api";
const defaultApiBase = import.meta.env.DEV ? "" : "https://signal-api.zx-dx.xyz";
const apiBase = String(import.meta.env.PUBLIC_SIGNAL_API_BASE ?? defaultApiBase).replace(/\/$/, "");
const privateApiBase = import.meta.env.DEV ? apiBase : "/api/private/signal";
export const privateAccessUrl = "/api/private/signal/api/watches";
let mockWatches: WatchDossier[] = [];

export class SignalApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "SignalApiError";
  }
}

function endpoint(path: string): string {
  if (!apiBase) throw new SignalApiError("SIGNAL_API_NOT_CONFIGURED", "PUBLIC_SIGNAL_API_BASE is not configured", 503);
  const privatePath = path === "/api/annotations" || path === "/api/memories" || path.startsWith("/api/memory-candidates/") || path.startsWith("/api/memory/") || path === "/api/watches" || /^\/api\/watches\/[^/]+\/resolve$/.test(path) || path.startsWith("/api/admin/");
  return `${privatePath ? privateApiBase : apiBase}${path}`;
}

function networkMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Signal API unavailable";
  if (/failed to fetch|load failed|networkerror|fetch failed/i.test(message)) {
    return `需要先完成统一 Cloudflare Access 授权。请在新标签打开 ${privateAccessUrl} 完成登录后重试`;
  }
  return message;
}

async function apiRequest<T>(path: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      ...init,
      credentials: "include",
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new SignalApiError("SIGNAL_API_UNAVAILABLE", networkMessage(cause), 503);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new SignalApiError("SIGNAL_ACCESS_REQUIRED", networkMessage(new Error("Failed to fetch")), 401);
  }
  if (!response.ok) {
    let error: SignalErrorResponse | undefined;
    try { error = await response.json() as SignalErrorResponse; } catch { /* Non-JSON proxy response. */ }
    throw new SignalApiError(error?.error.code ?? "SIGNAL_API_ERROR", error?.error.message ?? `Signal API returned ${response.status}`, response.status);
  }
  return await response.json() as T;
}

export async function getLatestBriefing(state: BriefingPreviewState = "ready"): Promise<DailyBriefing> {
  if (dataMode === "mock") return createMockBriefing(state);
  return apiRequest<DailyBriefing>("/api/briefings/latest");
}

export async function submitAnnotation(input: AnnotationInput): Promise<AnnotationResponse> {
  if (dataMode === "mock") {
    const annotation = { ...input, id: `annotation-${Date.now()}`, createdAt: new Date().toISOString() };
    return createMockAnnotationResponse(annotation);
  }
  return apiRequest<AnnotationResponse>("/api/annotations", {
    method: "POST",
    body: JSON.stringify({ ...input, actionType: input.action }),
  }, 45_000);
}

function annotationStreamEvent(value: unknown): AnnotationStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SignalApiError("SIGNAL_STREAM_ERROR", "Signal stream returned an invalid event", 502);
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") throw new SignalApiError("SIGNAL_STREAM_ERROR", "Signal stream returned an invalid event", 502);
  return value as AnnotationStreamEvent;
}

async function* parseAnnotationStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AnnotationStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const parseData = (): AnnotationStreamEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    return annotationStreamEvent(JSON.parse(data) as unknown);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          const event = parseData();
          if (event) yield event;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    const finalLine = buffer.replace(/\r$/, "");
    if (finalLine.startsWith("data:")) dataLines.push(finalLine.slice(5).trimStart());
    const event = parseData();
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

export async function* submitAnnotationStream(input: AnnotationInput): AsyncGenerator<AnnotationStreamEvent> {
  if (dataMode === "mock") {
    const annotation = { ...input, id: `annotation-${Date.now()}`, createdAt: new Date().toISOString() };
    const response = createMockAnnotationResponse(annotation);
    yield { type: "start" };
    for (const chunk of response.reply.content.match(/.{1,12}/gs) ?? [response.reply.content]) {
      yield { type: "reply_delta", text: chunk };
    }
    yield { type: "reply", annotation: response.annotation, reply: response.reply };
    yield { type: "memory", memoryCandidate: response.memoryCandidate };
    yield { type: "done", response };
    return;
  }
  let response: Response;
  try {
    response = await fetch(endpoint("/api/annotations?stream=1"), {
      method: "POST",
      credentials: "include",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, actionType: input.action }),
    });
  } catch (cause) {
    try {
      yield { type: "done", response: await submitAnnotation(input) };
      return;
    } catch (fallbackCause) {
      if (fallbackCause instanceof SignalApiError) throw fallbackCause;
      throw new SignalApiError("SIGNAL_API_UNAVAILABLE", networkMessage(cause), 503);
    }
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new SignalApiError("SIGNAL_ACCESS_REQUIRED", networkMessage(new Error("Failed to fetch")), 401);
  }
  if (!response.ok) {
    let error: SignalErrorResponse | undefined;
    try { error = await response.json() as SignalErrorResponse; } catch { /* Non-JSON proxy response. */ }
    throw new SignalApiError(error?.error.code ?? "SIGNAL_API_ERROR", error?.error.message ?? `Signal API returned ${response.status}`, response.status);
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    yield { type: "done", response: await response.json() as AnnotationResponse };
    return;
  }
  yield* parseAnnotationStream(response.body);
}

export async function updateMemoryCandidate(
  candidate: MemoryCandidate,
  action: "accept" | "reject",
  scope?: MemoryScope,
  scopeKey?: string,
): Promise<MemoryCandidate> {
  if (dataMode === "mock") return updateMockMemoryCandidate(candidate, action, scope);
  const response = await apiRequest<{ candidate: MemoryCandidate }>(`/api/memory-candidates/${encodeURIComponent(candidate.id)}/${action}`, {
    method: "POST",
    body: JSON.stringify(action === "accept" ? { scope, scopeKey } : {}),
  }, 15_000);
  return response.candidate;
}

export async function getMemories(): Promise<MemoriesResponse> {
  if (dataMode === "mock") return { memories: [], candidates: [] };
  return apiRequest<MemoriesResponse>("/api/memories");
}

export async function getWatches(): Promise<WatchDossier[]> {
  if (dataMode === "mock") return structuredClone(mockWatches);
  const response = await apiRequest<WatchesResponse>("/api/watches");
  return response.watches;
}

export async function createWatch(input: CreateWatchRequest): Promise<WatchDossier> {
  if (dataMode === "mock") {
    const now = new Date().toISOString();
    const watch: WatchDossier = {
      id: `watch-${Date.now()}`,
      title: "本地预览追踪",
      condition: input.condition,
      category: "zxlab",
      status: "active",
      seedBriefingId: input.briefingId,
      seedBriefingItemId: input.briefingItemId,
      createdAt: now,
      updatedAt: now,
      observations: [{
        id: `watch-observation-${Date.now()}`,
        type: "created",
        briefingId: input.briefingId,
        briefingItemId: input.briefingItemId,
        title: "追踪已建立",
        summary: "这是本地预览中的初始观察。连接 Signal API 后，服务端会从真实日报条目补全来源。",
        sources: [],
        observedAt: now,
      }],
    };
    mockWatches = [watch, ...mockWatches];
    return structuredClone(watch);
  }
  const response = await apiRequest<WatchResponse>("/api/watches", {
    method: "POST",
    body: JSON.stringify(input),
  }, 15_000);
  return response.watch;
}

export async function resolveWatch(id: string): Promise<WatchDossier> {
  if (dataMode === "mock") {
    const watch = mockWatches.find((candidate) => candidate.id === id);
    if (!watch) throw new SignalApiError("WATCH_NOT_FOUND", "Watch does not exist", 404);
    const resolved = { ...watch, status: "resolved" as const, resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    mockWatches = mockWatches.map((candidate) => candidate.id === id ? resolved : candidate);
    return structuredClone(resolved);
  }
  const response = await apiRequest<WatchResponse>(`/api/watches/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: JSON.stringify({}),
  }, 15_000);
  return response.watch;
}
