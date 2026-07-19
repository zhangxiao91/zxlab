import { DurableObject } from "cloudflare:workers";
import type { Device, DeviceCapability, DevicePlatform, DropItem, DropPayload, DropStatus, PublicPulseSnapshot } from "../../shared/types";
import { constantTimeEqual, hashToken } from "./security";

const DROP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 50;

interface MailboxState {
  device: Device;
  tokenHash: string;
  pairedDevices: Device[];
  inbox: DropItem[];
  sent: DropItem[];
  revoked: boolean;
  pulse?: PublicPulseSnapshot;
}

interface SocketTicket { hash: string; expiresAt: number; }

export class DeviceMailbox extends DurableObject<Env> {
  async issueSocketTicket(hash: string, expiresAt: number): Promise<void> {
    await this.ctx.storage.put<SocketTicket>("inbox-socket-ticket", { hash, expiresAt });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const ticketValue = new URL(request.url).searchParams.get("ticket") ?? "";
    const ticket = await this.ctx.storage.get<SocketTicket>("inbox-socket-ticket");
    if (!ticketValue || !ticket || ticket.expiresAt <= Date.now() || !constantTimeEqual(await hashToken(ticketValue), ticket.hash)) return new Response("Socket ticket unavailable", { status: 401 });
    await this.ctx.storage.delete("inbox-socket-ticket");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["inbox"]);
    server.serializeAttachment({ connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "connected" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async notifyInbox(item: DropItem): Promise<void> {
    const message = JSON.stringify({ type: "drop_ready", item });
    for (const socket of this.ctx.getWebSockets("inbox")) {
      try { socket.send(message); } catch { /* closed sockets are removed by the runtime */ }
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as unknown;
      if (parsed && typeof parsed === "object" && "type" in parsed && parsed.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore malformed client frames */ }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
  }

  async initialize(device: Device, tokenHash: string): Promise<void> {
    const existing = await this.ctx.storage.get<MailboxState>("mailbox");
    if (existing) return;
    await this.ctx.storage.put<MailboxState>("mailbox", {
      device,
      tokenHash,
      pairedDevices: [],
      inbox: [],
      sent: [],
      revoked: false
    });
  }

  async addPair(device: Device): Promise<void> {
    const state = await this.requiredState();
    state.pairedDevices = [device, ...state.pairedDevices.filter((item) => item.id !== device.id)];
    await this.ctx.storage.put("mailbox", state);
  }

  async removePair(token: string, targetId: string): Promise<boolean> {
    const state = await this.authorizedState(token);
    if (!state) return false;
    state.pairedDevices = state.pairedDevices.filter((item) => item.id !== targetId);
    await this.ctx.storage.put("mailbox", state);
    return true;
  }

  async removePairInternal(targetId: string): Promise<void> {
    const state = await this.requiredState();
    state.pairedDevices = state.pairedDevices.filter((item) => item.id !== targetId);
    await this.ctx.storage.put("mailbox", state);
  }

  async listDevices(token: string): Promise<{ device: Device; pairedDevices: Device[] } | null> {
    const state = await this.authorizedState(token);
    if (!state) return null;
    state.device.lastSeenAt = new Date().toISOString();
    await this.ctx.storage.put("mailbox", state);
    state.device = normalizeDevice(state.device);
    state.pairedDevices = state.pairedDevices.map(normalizeDevice);
    return { device: state.device, pairedDevices: state.pairedDevices };
  }

  async publishPulse(token: string, snapshot: PublicPulseSnapshot): Promise<{ deviceName: string; snapshot: PublicPulseSnapshot } | null> {
    const state = await this.authorizedState(token);
    if (!state) return null;
    state.device = normalizeDevice(state.device);
    if (!state.device.capabilities.includes("pulse.publish")) return null;
    state.pulse = snapshot;
    state.device.lastSeenAt = new Date().toISOString();
    await this.ctx.storage.put("mailbox", state);
    await this.scheduleCleanup(state);
    return { deviceName: state.device.name, snapshot };
  }

  async getPulse(token: string): Promise<PublicPulseSnapshot | null | false> {
    const state = await this.authorizedState(token);
    if (!state) return false;
    if (state.pulse && Date.parse(state.pulse.expiresAt) <= Date.now()) state.pulse = undefined;
    await this.ctx.storage.put("mailbox", state);
    return state.pulse ?? null;
  }

  async publishPulseInternal(device: Device, snapshot: PublicPulseSnapshot): Promise<{ deviceName: string; snapshot: PublicPulseSnapshot } | null> {
    const state = await this.requiredState();
    const normalized = normalizeDevice(device);
    if (state.revoked || !normalized.capabilities.includes("pulse.publish")) return null;
    state.device = normalized;
    state.pulse = snapshot;
    await this.ctx.storage.put("mailbox", state);
    await this.scheduleCleanup(state);
    return { deviceName: normalized.name, snapshot };
  }

  async getPulseInternal(): Promise<PublicPulseSnapshot | null> {
    const state = await this.requiredState();
    if (state.revoked) return null;
    if (state.pulse && Date.parse(state.pulse.expiresAt) <= Date.now()) {
      state.pulse = undefined;
      await this.ctx.storage.put("mailbox", state);
    }
    return state.pulse ?? null;
  }

  async revokeInternal(): Promise<void> {
    const state = await this.requiredState();
    state.revoked = true;
    state.device = { ...normalizeDevice(state.device), revokedAt: new Date().toISOString() };
    state.tokenHash = "revoked";
    await this.ctx.storage.put("mailbox", state);
  }

  async prepareDrop(token: string, receiverId: string, payload: DropPayload): Promise<{ sender: Device; item: DropItem } | null> {
    const state = await this.authorizedState(token);
    if (!state || !state.pairedDevices.some((device) => device.id === receiverId)) return null;
    this.purge(state);
    const now = Date.now();
    const item: DropItem = {
      id: crypto.randomUUID(),
      senderDeviceId: state.device.id,
      senderDeviceName: state.device.name,
      receiverDeviceId: receiverId,
      payload,
      status: "sent",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DROP_TTL_MS).toISOString()
    };
    state.sent = [item, ...state.sent].slice(0, MAX_ITEMS);
    await this.ctx.storage.put("mailbox", state);
    await this.scheduleCleanup(state);
    return { sender: state.device, item };
  }

  async receiveDrop(sender: Device, item: DropItem): Promise<boolean> {
    const state = await this.requiredState();
    if (state.revoked || !state.pairedDevices.some((device) => device.id === sender.id)) return false;
    this.purge(state);
    state.inbox = [{ ...item, status: "delivered" as const }, ...state.inbox.filter((entry) => entry.id !== item.id)].slice(0, MAX_ITEMS);
    await this.ctx.storage.put("mailbox", state);
    await this.scheduleCleanup(state);
    return true;
  }

  async getInbox(token: string): Promise<DropItem[] | null> {
    const state = await this.authorizedState(token);
    if (!state) return null;
    this.purge(state);
    await this.ctx.storage.put("mailbox", state);
    return state.inbox;
  }

  async getRecent(token: string): Promise<DropItem[] | null> {
    const state = await this.authorizedState(token);
    if (!state) return null;
    this.purge(state);
    await this.ctx.storage.put("mailbox", state);
    return state.sent.slice(0, 10);
  }

  async markStatus(dropId: string, status: DropStatus): Promise<void> {
    const state = await this.requiredState();
    state.sent = state.sent.map((item) => item.id === dropId ? { ...item, status } : item);
    await this.ctx.storage.put("mailbox", state);
  }

  async markOpened(token: string, dropId: string): Promise<DropItem | null> {
    const state = await this.authorizedState(token);
    if (!state) return null;
    const item = state.inbox.find((entry) => entry.id === dropId);
    if (!item) return null;
    state.inbox = state.inbox.map((entry) => entry.id === dropId ? { ...entry, status: "opened" as const } : entry);
    await this.ctx.storage.put("mailbox", state);
    return { ...item, status: "opened" };
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<MailboxState>("mailbox");
    if (!state) return;
    this.purge(state);
    await this.ctx.storage.put("mailbox", state);
    await this.scheduleCleanup(state);
  }

  private async authorizedState(token: string): Promise<MailboxState | null> {
    if (!token) return null;
    const state = await this.ctx.storage.get<MailboxState>("mailbox");
    if (!state || state.revoked) return null;
    return constantTimeEqual(await hashToken(token), state.tokenHash) ? state : null;
  }

  private async requiredState(): Promise<MailboxState> {
    const state = await this.ctx.storage.get<MailboxState>("mailbox");
    if (!state) throw new Error("mailbox_not_initialized");
    return state;
  }

  private purge(state: MailboxState): void {
    const now = Date.now();
    state.inbox = state.inbox.filter((item) => Date.parse(item.expiresAt) > now);
    state.sent = state.sent.filter((item) => Date.parse(item.expiresAt) > now);
    if (state.pulse && Date.parse(state.pulse.expiresAt) <= now) state.pulse = undefined;
  }

  private async scheduleCleanup(state: MailboxState): Promise<void> {
    const expirations = [...state.inbox, ...state.sent].map((item) => Date.parse(item.expiresAt)).filter(Number.isFinite);
    if (state.pulse) expirations.push(Date.parse(state.pulse.expiresAt));
    if (expirations.length) await this.ctx.storage.setAlarm(Math.min(...expirations));
  }
}

interface LegacyDevice extends Omit<Device, "platform" | "capabilities" | "credentialVersion"> { type?: string; }
function normalizeDevice(value: Device | LegacyDevice): Device {
  const legacy = value as LegacyDevice;
  const platform: DevicePlatform = "platform" in value ? value.platform : legacy.type === "mac" ? "macos" : legacy.type === "windows" ? "windows" : "web";
  const capabilities: DeviceCapability[] = "capabilities" in value ? value.capabilities : ["drop.send", "drop.receive", "pulse.publish", "pulse.consume"];
  const normalized = { ...value } as LegacyDevice & { type?: string };
  delete normalized.type;
  return { ...normalized, platform, capabilities, credentialVersion: "credentialVersion" in value ? value.credentialVersion : 1 } as Device;
}
