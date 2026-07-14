import { describe, expect, it } from "vitest";
import { classifyClipboard, validateDropPayload } from "../../shared/payload";

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
});
