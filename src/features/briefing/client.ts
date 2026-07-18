import { createMockAnnotationResponse, createMockBriefing, updateMockMemoryCandidate } from "./mock";
import type {
  AnnotationInput,
  AnnotationResponse,
  BriefingPreviewState,
  DailyBriefing,
  MemoriesResponse,
  MemoryCandidate,
  MemoryScope,
  SignalErrorResponse,
} from "./types";

const configuredMode = import.meta.env.PUBLIC_SIGNAL_DATA_MODE;
const dataMode: "api" | "mock" = configuredMode === "api" || configuredMode === "mock"
  ? configuredMode
  : import.meta.env.DEV ? "mock" : "api";
const defaultApiBase = import.meta.env.DEV ? "" : "https://zx-signal.zhangxiao9118.workers.dev";
const apiBase = String(import.meta.env.PUBLIC_SIGNAL_API_BASE ?? defaultApiBase).replace(/\/$/, "");

export class SignalApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "SignalApiError";
  }
}

function endpoint(path: string): string {
  if (!apiBase) throw new SignalApiError("SIGNAL_API_NOT_CONFIGURED", "PUBLIC_SIGNAL_API_BASE is not configured", 503);
  return `${apiBase}${path}`;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      ...init,
      credentials: "include",
      signal: init?.signal ?? AbortSignal.timeout(8_000),
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new SignalApiError("SIGNAL_API_UNAVAILABLE", cause instanceof Error ? cause.message : "Signal API unavailable", 503);
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
  });
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
  });
  return response.candidate;
}

export async function getMemories(): Promise<MemoriesResponse> {
  if (dataMode === "mock") return { memories: [], candidates: [] };
  return apiRequest<MemoriesResponse>("/api/memories");
}
