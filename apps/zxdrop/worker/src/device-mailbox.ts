import { DurableObject } from "cloudflare:workers";
import type { Device, DropItem, DropPayload, DropStatus } from "../../shared/types";
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
}

export class DeviceMailbox extends DurableObject<Env> {
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
    return { device: state.device, pairedDevices: state.pairedDevices };
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
  }

  private async scheduleCleanup(state: MailboxState): Promise<void> {
    const expirations = [...state.inbox, ...state.sent].map((item) => Date.parse(item.expiresAt)).filter(Number.isFinite);
    if (expirations.length) await this.ctx.storage.setAlarm(Math.min(...expirations));
  }
}
