import { DurableObject } from "cloudflare:workers";
import type { PublicPulseSnapshot, PublicStatusResponse } from "../../shared/types";

interface PulseEntry { deviceName: string; snapshot: PublicPulseSnapshot; }

export class PulseHub extends DurableObject<Env> {
  async upsert(deviceId: string, entry: PulseEntry): Promise<void> {
    await this.ctx.storage.put(`pulse:${deviceId}`, entry);
    await this.schedule();
  }

  async publicStatus(): Promise<PublicStatusResponse> {
    const records = await this.ctx.storage.list<PulseEntry>({ prefix: "pulse:" });
    const now = Date.now();
    const active = [...records.entries()].filter(([, entry]) => Date.parse(entry.snapshot.expiresAt) > now);
    const expired = [...records.entries()].filter(([, entry]) => Date.parse(entry.snapshot.expiresAt) <= now).map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
    const latest = active.sort((a, b) => Date.parse(b[1].snapshot.generatedAt) - Date.parse(a[1].snapshot.generatedAt));
    return {
      updatedAt: latest[0]?.[1].snapshot.generatedAt ?? null,
      stale: latest.length === 0,
      devices: latest.map(([, entry]) => ({ name: entry.deviceName, ...entry.snapshot.device })),
      ...(latest[0]?.[1].snapshot.activity ? { activity: latest[0][1].snapshot.activity } : {})
    };
  }

  async alarm(): Promise<void> { await this.publicStatus(); await this.schedule(); }

  private async schedule(): Promise<void> {
    const records = await this.ctx.storage.list<PulseEntry>({ prefix: "pulse:" });
    const expirations = [...records.values()].map((entry) => Date.parse(entry.snapshot.expiresAt)).filter((time) => time > Date.now());
    if (expirations.length) await this.ctx.storage.setAlarm(Math.min(...expirations));
  }
}
