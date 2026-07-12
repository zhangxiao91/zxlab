import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, friendlyUploadError } from "./api";
import { shareFile } from "./files";
import { isSessionExpired, receiverUrl } from "./session";
import { canTransition, parseClientMessage, shouldDeleteExpiredTransfer, validateUpload } from "../../worker/src/protocol";
import { constantTimeEqual, hashToken, randomToken } from "../../worker/src/security";

describe("temporary sessions", () => {
  it("creates an unpredictable token and a fragment-only receiver token", () => {
    const token = randomToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    const url = new URL(receiverUrl({ id: "session-id", token, expiresAt: 2000 }, "https://drop.example/"));
    expect(url.searchParams.get("session")).toBe("session-id");
    expect(url.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(token);
  });

  it("detects session expiry", () => {
    expect(isSessionExpired({ expiresAt: 999 }, 1000)).toBe(true);
    expect(isSessionExpired({ expiresAt: 1001 }, 1000)).toBe(false);
  });

  it("validates token digests without accepting a different token", async () => {
    const expected = await hashToken("correct");
    expect(constantTimeEqual(await hashToken("correct"), expected)).toBe(true);
    expect(constantTimeEqual(await hashToken("wrong"), expected)).toBe(false);
  });
});

describe("transfer rules", () => {
  it("validates MIME type and size", () => {
    expect(validateUpload("image/png", 1024)).toBeNull();
    expect(validateUpload("application/pdf", 1024)).toContain("PNG");
    expect(validateUpload("image/png", 20 * 1024 * 1024 + 1)).toContain("20 MB");
  });

  it("allows only valid transfer state transitions", () => {
    expect(canTransition("uploading", "ready")).toBe(true);
    expect(canTransition("ready", "claimed")).toBe(true);
    expect(canTransition("claimed", "ready")).toBe(false);
    expect(canTransition("deleted", "ready")).toBe(false);
  });

  it("parses only supported WebSocket messages", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
    expect(parseClientMessage(JSON.stringify({ type: "claim", transferId: "t1" }))).toEqual({ type: "claim", transferId: "t1" });
    expect(parseClientMessage("not-json")).toBeNull();
  });

  it("marks expired non-deleted objects for cleanup", () => {
    expect(shouldDeleteExpiredTransfer({ expiresAt: 999, status: "ready" }, 1000)).toBe(true);
    expect(shouldDeleteExpiredTransfer({ expiresAt: 999, status: "deleted" }, 1000)).toBe(false);
  });

  it("turns upload failures into user-facing messages", () => {
    expect(friendlyUploadError(new ApiError("手机尚未连接", "RECEIVER_OFFLINE", 409))).toBe("手机尚未连接");
    expect(friendlyUploadError(new Error("socket stack"))).toBe("上传失败，请检查网络后重试");
  });
});

describe("Web Share fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("downloads when file sharing is unavailable", async () => {
    const click = vi.fn();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { setTimeout: (callback: () => void) => { callback(); return 1; } });
    vi.stubGlobal("document", { createElement: () => ({ click, set href(_value: string) {}, set download(_value: string) {} }) });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:test", revokeObjectURL: vi.fn() });
    const result = await shareFile(new Blob(["image"], { type: "image/png" }), "image.png");
    expect(result).toBe("downloaded");
    expect(click).toHaveBeenCalledOnce();
  });
});
