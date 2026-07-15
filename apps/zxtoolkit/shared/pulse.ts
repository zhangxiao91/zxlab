import type { BatteryLevel, Presence, PublicPulseSnapshot, StepsBucket } from "./types";

const presences: Presence[] = ["online", "recently_online", "offline"];
const batteries: BatteryLevel[] = ["high", "medium", "low"];
const steps: StepsBucket[] = ["0-2k", "2k-5k", "5k-8k", "8k-12k", "12k+"];

export function validatePulseSnapshot(value: unknown, now = Date.now()): PublicPulseSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const device = input.device as Record<string, unknown> | undefined;
  const activity = input.activity as Record<string, unknown> | undefined;
  const generatedAt = typeof input.generatedAt === "string" ? Date.parse(input.generatedAt) : NaN;
  const expiresAt = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
  if (input.schemaVersion !== 1 || !device || !presences.includes(device.presence as Presence)) return null;
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt) || generatedAt > now + 60_000 || expiresAt <= now || expiresAt > now + 24 * 60 * 60 * 1000) return null;
  if (device.batteryLevel !== undefined && !batteries.includes(device.batteryLevel as BatteryLevel)) return null;
  if (device.charging !== undefined && typeof device.charging !== "boolean") return null;
  if (activity?.stepsBucket !== undefined && !steps.includes(activity.stepsBucket as StepsBucket)) return null;
  return {
    device: {
      presence: device.presence as Presence,
      ...(device.batteryLevel ? { batteryLevel: device.batteryLevel as BatteryLevel } : {}),
      ...(typeof device.charging === "boolean" ? { charging: device.charging } : {})
    },
    ...(activity?.stepsBucket ? { activity: { stepsBucket: activity.stepsBucket as StepsBucket } } : {}),
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    schemaVersion: 1
  };
}
