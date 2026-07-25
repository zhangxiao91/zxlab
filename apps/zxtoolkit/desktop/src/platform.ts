import type { Device, DeviceCredential, DropPayload } from "../../shared/types";
import { classifyClipboard } from "../../shared/payload";

const CREDENTIAL_KEY = "device-credential";
const DEFAULT_DEVICE_KEY = "default-device-id";

interface StoredCredentialMetadata { device: Device; token?: string; }
export interface ClipboardDrop { payload: DropPayload; blob?: Blob; }

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
    async loadCredential() {
      const store = await tauriStore();
      const stored = await store.get<StoredCredentialMetadata>(CREDENTIAL_KEY);
      if (!stored?.device?.id) return null;
      const { invoke } = await import("@tauri-apps/api/core");
      let token = await invoke<string | null>("keychain_get", { deviceId: stored.device.id });
      if (!token && stored.token) {
        await invoke("keychain_set", { deviceId: stored.device.id, token: stored.token });
        token = stored.token;
        await store.set(CREDENTIAL_KEY, credentialMetadata({ device: stored.device, token: stored.token }));
        await store.save();
      }
      return token ? { device: stored.device, token } : null;
    },
    async saveCredential(value) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("keychain_set", { deviceId: value.device.id, token: value.token });
      const store = await tauriStore();
      await store.set(CREDENTIAL_KEY, credentialMetadata(value));
      await store.save();
    },
    async loadDefaultDeviceId() { const store = await tauriStore(); return await store.get<string>(DEFAULT_DEVICE_KEY) ?? null; },
    async saveDefaultDeviceId(value) { const store = await tauriStore(); await store.set(DEFAULT_DEVICE_KEY, value); await store.save(); },
    async clear() {
      const store = await tauriStore();
      const stored = await store.get<StoredCredentialMetadata>(CREDENTIAL_KEY);
      if (stored?.device?.id) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("keychain_delete", { deviceId: stored.device.id });
      }
      await store.delete(CREDENTIAL_KEY);
      await store.delete(DEFAULT_DEVICE_KEY);
      await store.save();
    }
  };
}

export function credentialMetadata(value: DeviceCredential): { device: Device } {
  return { device: value.device };
}

export function resolveDefaultDeviceId(devices: Device[], stored: string | null): string {
  return devices.some((device) => device.id === stored) ? stored! : devices[0]?.id ?? "";
}

export async function readClipboardDrop(): Promise<ClipboardDrop> {
  if (isTauri()) {
    const clipboard = await import("@tauri-apps/plugin-clipboard-manager");
    try {
      const image = await clipboard.readImage();
      const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
      const blob = await rgbaToPng(rgba, size.width, size.height);
      return {
        payload: { type: "image", fileName: `剪贴板图片-${timestamp()}.png`, mimeType: "image/png", size: blob.size, width: size.width, height: size.height },
        blob
      };
    } catch { /* the clipboard may contain text instead */ }
    const text = (await clipboard.readText()).trim();
    if (!text) throw new Error("剪贴板是空的，请先复制文字、链接或图片");
    return { payload: classifyClipboard(text) };
  }

  if (navigator.clipboard.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const source = await item.getType(imageType);
      const blob = source.type === "image/png" ? source : await normalizeImage(source);
      return { payload: { type: "image", fileName: `剪贴板图片-${timestamp()}.png`, mimeType: "image/png", size: blob.size }, blob };
    }
  }
  const text = (await navigator.clipboard.readText()).trim();
  if (!text) throw new Error("剪贴板是空的，请先复制文字、链接或图片");
  return { payload: classifyClipboard(text) };
}

export async function notifyDelivery(message: string, dropId?: string): Promise<void> {
  if (!isTauri()) return;
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  let allowed = await isPermissionGranted();
  if (!allowed) allowed = await requestPermission() === "granted";
  if (allowed) sendNotification({ title: "zxtoolkit", body: message, extra: dropId ? { dropId } : undefined, autoCancel: true });
}

export async function listenForNotificationActions(handler: (dropId?: string) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { onAction } = await import("@tauri-apps/plugin-notification");
  const listener = await onAction((notification) => {
    const dropId = typeof notification.extra?.dropId === "string" ? notification.extra.dropId : undefined;
    handler(dropId);
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("show_main_window"));
  });
  return () => listener.unregister();
}

export async function writeClipboardText(value: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(value);
    return;
  }
  await navigator.clipboard.writeText(value);
}

export async function registerSendShortcut(handler: () => void): Promise<() => Promise<void>> {
  if (!isTauri()) return async () => undefined;
  const { register, unregister } = await import("@tauri-apps/plugin-global-shortcut");
  const shortcut = "CommandOrControl+Shift+D";
  await register(shortcut, (event) => { if (event.state === "Pressed") handler(); });
  return () => unregister(shortcut);
}

export async function listenForScreenshots(handler: (path: string) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("screenshot-created", (event) => handler(event.payload));
}

export async function screenshotDrop(path: string): Promise<ClipboardDrop> {
  if (!isTauri()) throw new Error("截图检测仅支持 macOS 应用");
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<number[]>("read_screenshot_file", { path });
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  const fileName = path.split("/").pop() || `截图-${timestamp()}.png`;
  return { payload: { type: "image", fileName, mimeType: "image/png", size: blob.size }, blob };
}

export async function saveReceivedFile(blob: Blob, fileName: string): Promise<string> {
  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return fileName;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("save_received_file", { fileName, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function quitApp(): Promise<void> {
  if (!isTauri()) { window.close(); return; }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
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

async function rgbaToPng(rgba: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前系统无法读取剪贴板图片");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("剪贴板图片编码失败")), "image/png"));
}

async function normalizeImage(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("剪贴板图片编码失败")), "image/png"));
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parse<T>(value: string | null): T | null {
  try { return value ? JSON.parse(value) as T : null; } catch { return null; }
}
