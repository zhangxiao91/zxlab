import { DurableObject } from "cloudflare:workers";
import type { Device, DeviceCredential, DevicePlatform, PairingStatusResponse } from "../../shared/types";
import { constantTimeEqual, hashToken, randomToken } from "./security";
import { createDevicePair, resetPairingConfirmation, setPairingStatus } from "./device-store";

interface PairingState {
  id: string;
  claimHash: string;
  desktopName: string;
  expiresAt: number;
  status: "pending" | "confirming" | "confirmed" | "expired";
  desktopCredential?: DeviceCredential;
  receiver?: Device;
}

export class PairingSession extends DurableObject<Env> {
  async initialize(id: string, claimHash: string, desktopName: string, expiresAt: number): Promise<void> {
    if (await this.ctx.storage.get("pairing")) return;
    await this.ctx.storage.put<PairingState>("pairing", { id, claimHash, desktopName, expiresAt, status: "pending" });
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

  async confirm(receiverName: string, receiverPlatform: DevicePlatform): Promise<DeviceCredential | null> {
    const state = await this.ctx.storage.get<PairingState>("pairing");
    if (!state || state.status !== "pending" || state.expiresAt <= Date.now()) return null;
    if (!(await setPairingStatus(this.env.DB, state.id, "confirming"))) return null;
    state.status = "confirming";
    await this.ctx.storage.put("pairing", state);
    const createdAt = new Date().toISOString();
    const desktop: Device = { id: crypto.randomUUID(), name: state.desktopName, platform: "macos", capabilities: ["drop.send", "drop.receive", "pulse.publish", "pulse.consume"], createdAt, credentialVersion: 1 };
    const receiver: Device = { id: crypto.randomUUID(), name: receiverName, platform: receiverPlatform, capabilities: ["drop.send", "drop.receive", "pulse.publish", "pulse.consume"], createdAt, credentialVersion: 1 };
    const desktopToken = randomToken();
    const receiverToken = randomToken();

    const [desktopTokenHash, receiverTokenHash] = await Promise.all([hashToken(desktopToken), hashToken(receiverToken)]);

    try {
      await createDevicePair(this.env.DB, desktop, desktopTokenHash, receiver, receiverTokenHash, state.id);
      const desktopMailbox = this.env.DEVICES.getByName(desktop.id);
      const receiverMailbox = this.env.DEVICES.getByName(receiver.id);
      await Promise.all([
        desktopMailbox.initialize(desktop, desktopTokenHash),
        receiverMailbox.initialize(receiver, receiverTokenHash)
      ]);
      await Promise.all([desktopMailbox.addPair(receiver), receiverMailbox.addPair(desktop)]);

      state.status = "confirmed";
      state.desktopCredential = { device: desktop, token: desktopToken };
      state.receiver = receiver;
      await this.ctx.storage.put("pairing", state);
      return { device: receiver, token: receiverToken };
    } catch (error) {
      state.status = "pending";
      await this.ctx.storage.put("pairing", state);
      await resetPairingConfirmation(this.env.DB, state.id);
      throw error;
    }
  }

  async cancel(claimToken: string): Promise<boolean> {
    const state = await this.ctx.storage.get<PairingState>("pairing");
    if (!state || state.status !== "pending" || !constantTimeEqual(await hashToken(claimToken), state.claimHash)) return false;
    state.status = "expired";
    await this.ctx.storage.put("pairing", state);
    await setPairingStatus(this.env.DB, state.id, "cancelled");
    return true;
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<PairingState>("pairing");
    if (!state) return;
    state.status = "expired";
    state.desktopCredential = undefined;
    await this.ctx.storage.put("pairing", state);
    await setPairingStatus(this.env.DB, state.id, "expired");
  }
}
