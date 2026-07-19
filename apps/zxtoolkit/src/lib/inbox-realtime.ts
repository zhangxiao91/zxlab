import type { DeviceCredential, DropItem } from "../../shared/types";
import { inboxSocket } from "./device-api";

const LEADER_KEY = "zxtoolkit.inbox-realtime-leader";
const LEASE_MS = 12_000;

interface Lease { id: string; expiresAt: number; }

export function startInboxRealtime(
  credential: DeviceCredential,
  handlers: { onItem: (item: DropItem) => void; onState: (state: "connecting" | "connected" | "disconnected") => void; onRefresh: () => void }
): () => void {
  const tabId = crypto.randomUUID();
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("zxtoolkit-inbox") : null;
  let stopSocket: (() => void) | null = null;
  let stopped = false;

  const releaseSocket = () => { stopSocket?.(); stopSocket = null; };
  const becomeLeader = () => {
    if (stopSocket) return;
    stopSocket = inboxSocket(credential, {
      onItem(item) { handlers.onItem(item); channel?.postMessage({ type: "item", item }); },
      onState: handlers.onState,
      onReconnect() { handlers.onRefresh(); channel?.postMessage({ type: "refresh" }); }
    });
  };
  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const current = readLease();
    if (!current || current.expiresAt <= now || current.id === tabId) {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: tabId, expiresAt: now + LEASE_MS } satisfies Lease));
      becomeLeader();
    } else {
      releaseSocket();
      handlers.onState("connected");
    }
  };

  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data as unknown;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type === "refresh") handlers.onRefresh();
      if (data.type === "item" && "item" in data && data.item && typeof data.item === "object") handlers.onItem(data.item as DropItem);
    };
  }
  const timer = window.setInterval(tick, 4_000);
  const onVisible = () => document.visibilityState === "visible" && tick();
  document.addEventListener("visibilitychange", onVisible);
  tick();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    releaseSocket();
    channel?.close();
    const current = readLease();
    if (current?.id === tabId) localStorage.removeItem(LEADER_KEY);
  };
}

function readLease(): Lease | null {
  try {
    const value = JSON.parse(localStorage.getItem(LEADER_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object" || !("id" in value) || !("expiresAt" in value)) return null;
    return typeof value.id === "string" && typeof value.expiresAt === "number" ? { id: value.id, expiresAt: value.expiresAt } : null;
  } catch { return null; }
}
