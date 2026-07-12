import type { TransferSession } from "../types";

const STORAGE_KEY = "zxdrop.active-session";

export function saveSession(session: TransferSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(now = Date.now()): TransferSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isSession(value) || value.expiresAt <= now) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function isSessionExpired(session: Pick<TransferSession, "expiresAt">, now = Date.now()): boolean {
  return session.expiresAt <= now;
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function parseReceiverSession(location: Pick<Location, "search" | "hash">): TransferSession | null {
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const id = search.get("session");
  const token = hash.get("token");
  const expiresAt = Number(hash.get("expires"));
  return id && token && Number.isFinite(expiresAt) ? { id, token, expiresAt } : null;
}

export function receiverUrl(session: TransferSession, appUrl: string): string {
  const url = new URL(appUrl);
  url.searchParams.set("session", session.id);
  url.searchParams.set("mode", "receive");
  url.hash = new URLSearchParams({ token: session.token, expires: String(session.expiresAt) }).toString();
  return url.toString();
}

function isSession(value: unknown): value is TransferSession {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string" && "token" in value && typeof value.token === "string" && "expiresAt" in value && typeof value.expiresAt === "number");
}
