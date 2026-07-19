import { describe, expect, it } from "vitest";
import { canAdvanceDropStatus, classifyClipboard, validateDropPayload } from "../../shared/payload";

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
});
