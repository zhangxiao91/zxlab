import type { Device, DeviceCredential, DevicePlatform, DropItem, DropPayload, InboxPage, PairingSessionResponse, PairingStatusResponse, PublicPulseSnapshot, PublicStatusResponse } from "../../shared/types";
import { API_BASE_URL, ApiError } from "./api";

const WEB_CREDENTIAL_KEY = "zxtoolkit.web-device";
const LEGACY_WEB_CREDENTIAL_KEY = "zxdrop.web-device";

export function loadWebCredential(): DeviceCredential | null {
  try {
    const raw = localStorage.getItem(WEB_CREDENTIAL_KEY) ?? localStorage.getItem(LEGACY_WEB_CREDENTIAL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as DeviceCredential;
    if (value?.device?.id && value.token) { localStorage.setItem(WEB_CREDENTIAL_KEY, raw); return value; }
    return null;
  } catch { return null; }
}

export function saveWebCredential(credential: DeviceCredential): void {
  localStorage.setItem(WEB_CREDENTIAL_KEY, JSON.stringify(credential));
}

export function clearWebCredential(): void {
  localStorage.removeItem(WEB_CREDENTIAL_KEY);
  localStorage.removeItem(LEGACY_WEB_CREDENTIAL_KEY);
}

export async function createPairingSession(desktopName: string): Promise<PairingSessionResponse> {
  return request("/api/pairing/sessions", { method: "POST", body: JSON.stringify({ desktopName }), headers: { "content-type": "application/json" } });
}

export async function getPairingStatus(id: string, claimToken: string): Promise<PairingStatusResponse> {
  return request(`/api/pairing/sessions/${id}`, { headers: { authorization: `Bearer ${claimToken}` } });
}

export async function confirmPairing(id: string, name: string, platform: DevicePlatform): Promise<DeviceCredential> {
  const result = await request<{ credential: DeviceCredential }>(`/api/pairing/sessions/${id}/confirm`, {
    method: "POST", body: JSON.stringify({ name, platform }), headers: { "content-type": "application/json" }
  });
  return result.credential;
}

export async function getDevices(credential: DeviceCredential): Promise<{ device: Device; pairedDevices: Device[] }> {
  return request("/api/devices", { headers: auth(credential) });
}

export async function removeDevice(credential: DeviceCredential, id: string): Promise<void> {
  await request(`/api/devices/${id}`, { method: "DELETE", headers: auth(credential) });
}

export async function renameCurrentDevice(credential: DeviceCredential, name: string): Promise<Device> {
  const result = await request<{ device: Device }>(`/api/devices/${credential.device.id}`, {
    method: "PATCH", headers: { ...auth(credential), "content-type": "application/json" }, body: JSON.stringify({ name })
  });
  return result.device;
}

export async function rotateDeviceCredential(credential: DeviceCredential): Promise<DeviceCredential> {
  const result = await request<{ credential: DeviceCredential }>("/api/devices/credential/rotate", { method: "POST", headers: auth(credential) });
  return result.credential;
}

export async function sendDrop(credential: DeviceCredential, receiverDeviceId: string, payload: DropPayload): Promise<DropItem> {
  const result = await request<{ item: DropItem }>("/api/drops", {
    method: "POST", headers: { ...auth(credential), "content-type": "application/json" }, body: JSON.stringify({ receiverDeviceId, payload })
  });
  return result.item;
}

export async function getInbox(credential: DeviceCredential): Promise<DropItem[]> {
  return (await getInboxPage(credential)).items;
}

export async function getInboxPage(credential: DeviceCredential, cursor?: string, limit = 30): Promise<InboxPage> {
  const search = new URLSearchParams({ limit: String(limit) });
  if (cursor) search.set("cursor", cursor);
  return request(`/api/inbox?${search}`, { headers: auth(credential) });
}

export async function getRecentDrops(credential: DeviceCredential): Promise<DropItem[]> {
  const result = await request<{ items: DropItem[] }>("/api/drops/recent", { headers: auth(credential) });
  return result.items;
}

export async function markDropOpened(credential: DeviceCredential, dropId: string): Promise<void> {
  await markDropStatus(credential, dropId, "opened");
}

export async function markDropStatus(credential: DeviceCredential, dropId: string, status: "opened" | "claimed"): Promise<DropItem> {
  const result = await request<{ item: DropItem }>(`/api/transfers/${dropId}/status`, {
    method: "PATCH", headers: { ...auth(credential), "content-type": "application/json" }, body: JSON.stringify({ status })
  });
  return result.item;
}

export function uploadDropImage(credential: DeviceCredential, item: DropItem, file: Blob, onProgress: (value: number) => void): { promise: Promise<DropItem>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<DropItem>((resolve, reject) => {
    xhr.open("POST", `${API_BASE_URL}/api/transfers/${item.id}/content`);
    xhr.setRequestHeader("authorization", `Bearer ${credential.token}`);
    xhr.setRequestHeader("x-device-id", credential.device.id);
    xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onerror = () => reject(new ApiError("图片上传中断，请检查网络后重试", "NETWORK_ERROR", 0));
    xhr.onabort = () => reject(new ApiError("图片上传已取消", "ABORTED", 0));
    xhr.onload = () => {
      const body = parseBody(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && body && "item" in body) resolve(body.item as DropItem);
      else reject(new ApiError(problemMessage(body), problemCode(body), xhr.status));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function fetchDropImage(credential: DeviceCredential, dropId: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/transfers/${dropId}/download`, { headers: auth(credential) });
  } catch {
    throw new ApiError("无法连接传输服务，请检查网络后重试", "NETWORK_ERROR", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    throw new ApiError(problemMessage(body), problemCode(body), response.status);
  }
  return response.blob();
}

export async function publishPulse(credential: DeviceCredential, snapshot: PublicPulseSnapshot): Promise<void> {
  await request("/api/pulse/snapshots", { method: "POST", headers: { ...auth(credential), "content-type": "application/json" }, body: JSON.stringify(snapshot) });
}

export async function getMyPulse(credential: DeviceCredential): Promise<PublicPulseSnapshot | null> {
  const result = await request<{ snapshot: PublicPulseSnapshot | null }>("/api/pulse/snapshots/latest", { headers: auth(credential) });
  return result.snapshot;
}

export async function getPublicStatus(): Promise<PublicStatusResponse> {
  return request("/api/public/status");
}

export function inboxSocket(
  credential: DeviceCredential,
  handlers: { onItem: (item: DropItem) => void; onState: (state: "connecting" | "connected" | "disconnected") => void; onReconnect: () => void }
): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry = 0;
  let retryTimer: number | undefined;
  let heartbeat: number | undefined;

  const connect = async () => {
    if (stopped) return;
    handlers.onState("connecting");
    try {
      const issued = await request<{ deviceId: string; ticket: string; expiresAt: number }>("/api/inbox/events/ticket", { method: "POST", headers: auth(credential) });
      if (stopped) return;
      const url = new URL(`${API_BASE_URL}/api/inbox/events`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("deviceId", issued.deviceId);
      url.searchParams.set("ticket", issued.ticket);
      socket = new WebSocket(url);
      socket.onopen = () => {
        retry = 0;
        handlers.onState("connected");
        handlers.onReconnect();
        heartbeat = window.setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "ping" })), 25_000);
      };
      socket.onmessage = (event) => {
        const body = parseBody(String(event.data));
        if (body?.type === "drop_ready" && body.item && typeof body.item === "object") handlers.onItem(body.item as DropItem);
      };
      socket.onclose = scheduleReconnect;
      socket.onerror = () => socket?.close();
    } catch { scheduleReconnect(); }
  };

  const scheduleReconnect = () => {
    if (heartbeat) window.clearInterval(heartbeat);
    handlers.onState("disconnected");
    if (stopped || retryTimer) return;
    const delay = Math.min(1000 * 2 ** retry, 30_000) + Math.floor(Math.random() * 300);
    retry += 1;
    retryTimer = window.setTimeout(() => { retryTimer = undefined; void connect(); }, delay);
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible" || stopped || socket?.readyState === WebSocket.OPEN) return;
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = undefined;
    void connect();
  };
  document.addEventListener("visibilitychange", onVisible);
  void connect();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    if (retryTimer) window.clearTimeout(retryTimer);
    if (heartbeat) window.clearInterval(heartbeat);
    socket?.close(1000, "Page closed");
  };
}

function auth(credential: DeviceCredential): Record<string, string> {
  return { authorization: `Bearer ${credential.token}`, "x-device-id": credential.device.id };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init);
  } catch {
    throw new ApiError("无法连接传输服务，请检查网络后重试", "NETWORK_ERROR", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(body.error?.message || "请求失败，请稍后重试", body.error?.code || "REQUEST_FAILED", response.status);
  }
  return response.json() as Promise<T>;
}

function parseBody(value: string): Record<string, unknown> | null { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
function problemMessage(value: Record<string, unknown> | null): string {
  const error = value?.error;
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : "请求失败，请稍后重试";
}
function problemCode(value: Record<string, unknown> | null): string {
  const error = value?.error;
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "REQUEST_FAILED";
}
