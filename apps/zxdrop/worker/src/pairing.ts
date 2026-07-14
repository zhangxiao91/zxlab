import { DurableObject } from "cloudflare:workers";
import type { Device, DeviceCredential, DeviceType, PairingStatusResponse } from "../../shared/types";
import { constantTimeEqual, hashToken, randomToken } from "./security";

interface PairingState {
  claimHash: string;
  desktopName: string;
  expiresAt: number;
  status: "pending" | "confirmed" | "expired";
  desktopCredential?: DeviceCredential;
  receiver?: Device;
}

export class PairingSession extends DurableObject<Env> {
  async initialize(claimHash: string, desktopName: string, expiresAt: number): Promise<void> {
    if (await this.ctx.storage.get("pairing")) return;
    await this.ctx.storage.put<PairingState>("pairing", { claimHash, desktopName, expiresAt, status: "pending" });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async status(claimToken: string): Promise<PairingStatusResponse | null> {
    const state = await this.ctx.storage.get<PairingState>("pairing");
    if (!state || !constantTimeEqual(await hashToken(claimToken), state.claimHash)) return null;
    if (state.expiresAt <= Date.now() || state.status === "expired") return { status: "expired" };
    if (state.status === "pending" || !state.desktopCredential || !state.receiver) {
      return { status: "pending", expiresAt: new Date(state.expiresAt).toISOString() };
    }
    return { status: "confirmed", credential: state.desktopCredential, receiver: state.receiver };
  }

  async confirm(receiverName: string, receiverType: DeviceType): Promise<DeviceCredential | null> {
    const state = await this.ctx.storage.get<PairingState>("pairing");
    if (!state || state.status !== "pending" || state.expiresAt <= Date.now()) return null;
    const createdAt = new Date().toISOString();
    const desktop: Device = { id: crypto.randomUUID(), name: state.desktopName, type: "mac", createdAt };
    const receiver: Device = { id: crypto.randomUUID(), name: receiverName, type: receiverType, createdAt };
    const desktopToken = randomToken();
    const receiverToken = randomToken();

    const desktopMailbox = this.env.DEVICES.getByName(desktop.id);
    const receiverMailbox = this.env.DEVICES.getByName(receiver.id);
    await Promise.all([
      desktopMailbox.initialize(desktop, await hashToken(desktopToken)),
      receiverMailbox.initialize(receiver, await hashToken(receiverToken))
    ]);
    await Promise.all([desktopMailbox.addPair(receiver), receiverMailbox.addPair(desktop)]);

    state.status = "confirmed";
    state.desktopCredential = { device: desktop, token: desktopToken };
    state.receiver = receiver;
    await this.ctx.storage.put("pairing", state);
    return { device: receiver, token: receiverToken };
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<PairingState>("pairing");
    if (!state) return;
    state.status = "expired";
    state.desktopCredential = undefined;
    await this.ctx.storage.put("pairing", state);
  }
}
