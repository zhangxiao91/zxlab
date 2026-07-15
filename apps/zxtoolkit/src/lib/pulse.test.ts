import { describe, expect, it } from "vitest";
import { validatePulseSnapshot } from "../../shared/pulse";

const now = Date.parse("2026-07-15T10:00:00.000Z");
const valid = { device: { presence: "online", batteryLevel: "high", charging: true }, activity: { stepsBucket: "8k-12k" }, generatedAt: "2026-07-15T10:00:00.000Z", expiresAt: "2026-07-15T10:30:00.000Z", schemaVersion: 1 };

describe("Pulse public snapshot validation", () => {
  it("accepts only the public schema", () => { expect(validatePulseSnapshot(valid, now)).toEqual(valid); });
  it("rejects expired or unsupported schema versions", () => {
    expect(validatePulseSnapshot({ ...valid, expiresAt: "2026-07-15T09:59:00.000Z" }, now)).toBeNull();
    expect(validatePulseSnapshot({ ...valid, schemaVersion: 2 }, now)).toBeNull();
  });
  it("drops arbitrary fields instead of exposing them", () => {
    const result = validatePulseSnapshot({ ...valid, preciseLocation: "private", device: { ...valid.device, serialNumber: "private" } }, now);
    expect(result).toEqual(valid);
    expect(result).not.toHaveProperty("preciseLocation");
    expect(result?.device).not.toHaveProperty("serialNumber");
  });
});
