import { describe, expect, it } from "vitest";
import { canAdvanceDropStatus, classifyClipboard, validateDropPayload } from "../../shared/payload";
import { credentialMetadata, resolveDefaultDeviceId } from "../../desktop/src/platform";
import type { Device } from "../../shared/types";

describe("desktop clipboard payloads", () => {
  it("classifies http and https links", () => {
    expect(classifyClipboard("https://zx-dx.xyz/test")).toEqual({ type: "url", url: "https://zx-dx.xyz/test" });
    expect(classifyClipboard("http://example.com")).toEqual({ type: "url", url: "http://example.com/" });
  });

  it("classifies other clipboard content as text", () => {
    expect(classifyClipboard("  hello world  ")).toEqual({ type: "text", text: "hello world" });
  });

  it("rejects dangerous or oversized payloads", () => {
    expect(validateDropPayload({ type: "url", url: "javascript:alert(1)" })).toBeNull();
    expect(validateDropPayload({ type: "text", text: "x".repeat(20_001) })).toBeNull();
    expect(validateDropPayload({ type: "text", text: "hello" })).toEqual({ type: "text", text: "hello" });
  });

  it("accepts bounded image metadata and rejects oversized images", () => {
    expect(validateDropPayload({ type: "image", fileName: "shot.png", mimeType: "image/png", size: 1024, width: 800, height: 600 })).toEqual({
      type: "image", fileName: "shot.png", mimeType: "image/png", size: 1024, width: 800, height: 600
    });
    expect(validateDropPayload({ type: "image", fileName: "shot.png", mimeType: "image/png", size: 20 * 1024 * 1024 + 1 })).toBeNull();
    expect(validateDropPayload({ type: "image", fileName: "shot.svg", mimeType: "image/svg+xml", size: 1024 })).toBeNull();
  });

  it("only advances delivery states in order", () => {
    expect(canAdvanceDropStatus("delivered", "opened")).toBe(true);
    expect(canAdvanceDropStatus("delivered", "claimed")).toBe(true);
    expect(canAdvanceDropStatus("opened", "claimed")).toBe(true);
    expect(canAdvanceDropStatus("claimed", "opened")).toBe(false);
    expect(canAdvanceDropStatus("expired", "claimed")).toBe(false);
  });

  it("keeps the long-lived token out of Tauri Store metadata", () => {
    const device: Device = { id: "mac-1", name: "My Mac", platform: "macos", capabilities: ["drop.send"], createdAt: "2026-07-19T00:00:00.000Z", credentialVersion: 1 };
    expect(credentialMetadata({ device, token: "secret-token" })).toEqual({ device });
    expect("token" in credentialMetadata({ device, token: "secret-token" })).toBe(false);
  });

  it("keeps a valid default target and falls back when it is revoked", () => {
    const devices: Device[] = [
      { id: "phone-1", name: "Phone", platform: "ios", capabilities: ["drop.receive"], createdAt: "2026-07-19T00:00:00.000Z", credentialVersion: 1 },
      { id: "tablet-1", name: "Tablet", platform: "ios", capabilities: ["drop.receive"], createdAt: "2026-07-19T00:00:00.000Z", credentialVersion: 1 }
    ];
    expect(resolveDefaultDeviceId(devices, "tablet-1")).toBe("tablet-1");
    expect(resolveDefaultDeviceId(devices, "revoked-device")).toBe("phone-1");
    expect(resolveDefaultDeviceId([], "tablet-1")).toBe("");
  });
});
