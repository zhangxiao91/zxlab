import { DurableObject } from "cloudflare:workers";
import { evaluateQuota } from "./abuse-controls";

interface QuotaState {
  uploads: number;
  bytes: number;
  resetAt: number;
}

export interface QuotaReservation {
  accepted: boolean;
  reason?: "count" | "bytes";
  remainingUploads: number;
  remainingBytes: number;
}

export class UploadQuota extends DurableObject<Env> {
  async reserve(bytes: number, uploadLimit: number, byteLimit: number, resetAt: number): Promise<QuotaReservation> {
    const state = await this.state(resetAt);
    const decision = evaluateQuota(state, bytes, uploadLimit, byteLimit);
    if (decision === "count") {
      return { accepted: false, reason: "count", remainingUploads: 0, remainingBytes: Math.max(0, byteLimit - state.bytes) };
    }
    if (decision === "bytes") {
      return { accepted: false, reason: "bytes", remainingUploads: Math.max(0, uploadLimit - state.uploads), remainingBytes: Math.max(0, byteLimit - state.bytes) };
    }
    state.uploads += 1;
    state.bytes += bytes;
    await this.ctx.storage.put("quota", state);
    await this.ctx.storage.setAlarm(resetAt);
    return {
      accepted: true,
      remainingUploads: Math.max(0, uploadLimit - state.uploads),
      remainingBytes: Math.max(0, byteLimit - state.bytes)
    };
  }

  async commit(reservedBytes: number, actualBytes: number): Promise<void> {
    const state = await this.ctx.storage.get<QuotaState>("quota");
    if (!state) return;
    state.bytes = Math.max(0, state.bytes - Math.max(0, reservedBytes - actualBytes));
    await this.ctx.storage.put("quota", state);
  }

  async rollback(reservedBytes: number): Promise<void> {
    const state = await this.ctx.storage.get<QuotaState>("quota");
    if (!state) return;
    state.uploads = Math.max(0, state.uploads - 1);
    state.bytes = Math.max(0, state.bytes - reservedBytes);
    await this.ctx.storage.put("quota", state);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  private async state(resetAt: number): Promise<QuotaState> {
    const stored = await this.ctx.storage.get<QuotaState>("quota");
    if (stored && stored.resetAt > Date.now()) return stored;
    return { uploads: 0, bytes: 0, resetAt };
  }
}
