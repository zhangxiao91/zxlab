import type { DeviceCredential } from "../../shared/types";

const CREDENTIAL_KEY = "device-credential";
const DEFAULT_DEVICE_KEY = "default-device-id";

export interface CredentialStore {
  loadCredential(): Promise<DeviceCredential | null>;
  saveCredential(value: DeviceCredential): Promise<void>;
  loadDefaultDeviceId(): Promise<string | null>;
  saveDefaultDeviceId(value: string): Promise<void>;
  clear(): Promise<void>;
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function createCredentialStore(): CredentialStore {
  if (!isTauri()) return browserStore();
  return {
    async loadCredential() { const store = await tauriStore(); return await store.get<DeviceCredential>(CREDENTIAL_KEY) ?? null; },
    async saveCredential(value) { const store = await tauriStore(); await store.set(CREDENTIAL_KEY, value); await store.save(); },
    async loadDefaultDeviceId() { const store = await tauriStore(); return await store.get<string>(DEFAULT_DEVICE_KEY) ?? null; },
    async saveDefaultDeviceId(value) { const store = await tauriStore(); await store.set(DEFAULT_DEVICE_KEY, value); await store.save(); },
    async clear() { const store = await tauriStore(); await store.clear(); await store.save(); }
  };
}

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return readText();
  }
  return navigator.clipboard.readText();
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function tauriStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load("zxtoolkit-device.json", { autoSave: 100, defaults: {} });
}

function browserStore(): CredentialStore {
  return {
    async loadCredential() { return parse<DeviceCredential>(localStorage.getItem(CREDENTIAL_KEY)); },
    async saveCredential(value) { localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(value)); },
    async loadDefaultDeviceId() { return localStorage.getItem(DEFAULT_DEVICE_KEY); },
    async saveDefaultDeviceId(value) { localStorage.setItem(DEFAULT_DEVICE_KEY, value); },
    async clear() { localStorage.removeItem(CREDENTIAL_KEY); localStorage.removeItem(DEFAULT_DEVICE_KEY); }
  };
}

function parse<T>(value: string | null): T | null {
  try { return value ? JSON.parse(value) as T : null; } catch { return null; }
}
