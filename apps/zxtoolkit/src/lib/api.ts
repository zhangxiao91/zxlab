import type { RemoteTransfer, SessionSocketMessage, TransferSession } from "../types";

export const API_BASE_URL = (import.meta.env.VITE_ZXTOOLKIT_API_BASE_URL || import.meta.env.VITE_API_BASE_URL || "http://localhost:8787").replace(/\/$/, "");

interface ApiErrorBody { error?: { code?: string; message?: string } }

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export function friendlyUploadError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "上传已取消";
  return "上传失败，请检查网络后重试";
}

export async function createSession(): Promise<TransferSession> {
  const response = await fetch(`${API_BASE_URL}/api/sessions`, { method: "POST" });
  return readJson<TransferSession>(response);
}

export async function inspectSession(session: TransferSession): Promise<{ expiresAt: number; receiverOnline: boolean; senderOnline: boolean; transfer?: RemoteTransfer }> {
  const response = await fetch(`${API_BASE_URL}/api/sessions/${session.id}`, { headers: auth(session) });
  return readJson(response);
}

export function uploadImage(session: TransferSession, file: File, onProgress: (value: number) => void): { promise: Promise<RemoteTransfer>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<RemoteTransfer>((resolve, reject) => {
    xhr.open("POST", `${API_BASE_URL}/api/sessions/${session.id}/upload`);
    xhr.setRequestHeader("authorization", `Bearer ${session.token}`);
    xhr.setRequestHeader("content-type", file.type);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError("上传中断，请检查网络后重试", "NETWORK_ERROR", 0));
    xhr.onabort = () => reject(new ApiError("上传已取消", "ABORTED", 0));
    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && body && "transfer" in body) resolve(body.transfer as RemoteTransfer);
      else reject(toApiError(body as ApiErrorBody, xhr.status));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function fetchTransfer(session: TransferSession, transferId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/api/sessions/${session.id}/files/${transferId}`, { headers: auth(session) });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function claimTransfer(session: TransferSession, transferId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/sessions/${session.id}/files/${transferId}/claim`, { method: "POST", headers: auth(session) });
  if (!response.ok) throw await responseError(response);
}

export async function deleteTransfer(session: TransferSession, transferId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/sessions/${session.id}/files/${transferId}`, { method: "DELETE", headers: auth(session) });
  if (!response.ok) throw await responseError(response);
}

export function sessionSocket(session: TransferSession, role: "sender" | "receiver", handlers: { onMessage: (message: SessionSocketMessage) => void; onState: (state: "connecting" | "connected" | "disconnected") => void }): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let retryTimer: number | undefined;
  let heartbeat: number | undefined;

  const connect = () => {
    if (stopped || session.expiresAt <= Date.now()) return;
    handlers.onState("connecting");
    const url = new URL(`${API_BASE_URL}/api/sessions/${session.id}/socket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", session.token);
    url.searchParams.set("role", role);
    socket = new WebSocket(url);
    socket.onopen = () => {
      retry = 0;
      handlers.onState("connected");
      heartbeat = window.setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping" })), 25_000);
    };
    socket.onmessage = (event) => {
      try { handlers.onMessage(JSON.parse(String(event.data)) as SessionSocketMessage); } catch { /* ignore malformed server frames */ }
    };
    socket.onclose = () => {
      if (heartbeat) window.clearInterval(heartbeat);
      handlers.onState("disconnected");
      if (!stopped && session.expiresAt > Date.now()) {
        const delay = Math.min(1000 * 2 ** retry, 15_000) + Math.floor(Math.random() * 300);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      }
    };
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible" && (!socket || socket.readyState > WebSocket.OPEN)) {
      if (retryTimer) window.clearTimeout(retryTimer);
      connect();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  connect();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (retryTimer) window.clearTimeout(retryTimer);
    if (heartbeat) window.clearInterval(heartbeat);
    socket?.close(1000, "Page closed");
  };
}

function auth(session: TransferSession): HeadersInit { return { authorization: `Bearer ${session.token}` }; }
async function readJson<T>(response: Response): Promise<T> { if (!response.ok) throw await responseError(response); return response.json() as Promise<T>; }
async function responseError(response: Response): Promise<ApiError> { return toApiError(await response.json().catch(() => ({})) as ApiErrorBody, response.status); }
function toApiError(body: ApiErrorBody, status: number): ApiError { return new ApiError(body.error?.message || "请求失败，请稍后重试", body.error?.code || "REQUEST_FAILED", status); }
function parseJson(value: string): Record<string, unknown> | null { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
