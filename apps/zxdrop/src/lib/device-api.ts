import type { Device, DeviceCredential, DeviceType, DropItem, DropPayload, PairingSessionResponse, PairingStatusResponse } from "../../shared/types";
import { API_BASE_URL, ApiError } from "./api";

const WEB_CREDENTIAL_KEY = "zxdrop.web-device";

export function loadWebCredential(): DeviceCredential | null {
  try {
    const raw = localStorage.getItem(WEB_CREDENTIAL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as DeviceCredential;
    return value?.device?.id && value.token ? value : null;
  } catch { return null; }
}

export function saveWebCredential(credential: DeviceCredential): void {
  localStorage.setItem(WEB_CREDENTIAL_KEY, JSON.stringify(credential));
}

export async function createPairingSession(desktopName: string): Promise<PairingSessionResponse> {
  return request("/api/pairing/sessions", { method: "POST", body: JSON.stringify({ desktopName }), headers: { "content-type": "application/json" } });
}

export async function getPairingStatus(id: string, claimToken: string): Promise<PairingStatusResponse> {
  return request(`/api/pairing/sessions/${id}`, { headers: { authorization: `Bearer ${claimToken}` } });
}

export async function confirmPairing(id: string, name: string, type: DeviceType): Promise<DeviceCredential> {
  const result = await request<{ credential: DeviceCredential }>(`/api/pairing/sessions/${id}/confirm`, {
    method: "POST", body: JSON.stringify({ name, type }), headers: { "content-type": "application/json" }
  });
  return result.credential;
}

export async function getDevices(credential: DeviceCredential): Promise<{ device: Device; pairedDevices: Device[] }> {
  return request("/api/devices", { headers: auth(credential) });
}

export async function removeDevice(credential: DeviceCredential, id: string): Promise<void> {
  await request(`/api/devices/${id}`, { method: "DELETE", headers: auth(credential) });
}

export async function sendDrop(credential: DeviceCredential, receiverDeviceId: string, payload: DropPayload): Promise<DropItem> {
  const result = await request<{ item: DropItem }>("/api/drops", {
    method: "POST", headers: { ...auth(credential), "content-type": "application/json" }, body: JSON.stringify({ receiverDeviceId, payload })
  });
  return result.item;
}

export async function getInbox(credential: DeviceCredential): Promise<DropItem[]> {
  const result = await request<{ items: DropItem[] }>("/api/inbox", { headers: auth(credential) });
  return result.items;
}

export async function getRecentDrops(credential: DeviceCredential): Promise<DropItem[]> {
  const result = await request<{ items: DropItem[] }>("/api/drops/recent", { headers: auth(credential) });
  return result.items;
}

export async function markDropOpened(credential: DeviceCredential, dropId: string): Promise<void> {
  await request(`/api/drops/${dropId}/opened`, { method: "POST", headers: auth(credential) });
}

function auth(credential: DeviceCredential): Record<string, string> {
  return { authorization: `Bearer ${credential.token}`, "x-device-id": credential.device.id };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(body.error?.message || "请求失败，请稍后重试", body.error?.code || "REQUEST_FAILED", response.status);
  }
  return response.json() as Promise<T>;
}
