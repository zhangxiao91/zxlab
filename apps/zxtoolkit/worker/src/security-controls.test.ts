import { describe, expect, it } from "vitest";
import { BodyTooLargeError, declaredBodySize, guardedBodyStream, hasImageSignature, readBodyWithLimit } from "./request-body";
import { parseByteRange } from "./protocol";
import { isAcceptedResult } from "./turnstile";
import { evaluateQuota } from "./abuse-controls";
import { shouldTouchDevice } from "./device-store";

describe("upload body protection", () => {
  it("does not trust a missing content-length header", () => {
    expect(declaredBodySize(null)).toBeNull();
    expect(Number.isNaN(declaredBodySize("not-a-number"))).toBe(true);
  });

  it("stops a chunked body after the real byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      }
    });
    await expect(readBodyWithLimit(stream, 5)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("checks image signatures instead of trusting MIME alone", () => {
    expect(hasImageSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe(true);
    expect(hasImageSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "image/png")).toBe(false);
  });

  it("streams a bounded upload while reporting its actual size and signature prefix", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e]));
        controller.enqueue(new Uint8Array([0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]));
        controller.close();
      }
    });
    const guarded = await guardedBodyStream(source, 32, 12);
    expect(hasImageSignature(guarded.prefix, "image/png")).toBe(true);
    expect(Array.from(new Uint8Array(await new Response(guarded.body).arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
    await expect(guarded.completed).resolves.toEqual({ size: 11 });
  });

  it("fails a streaming upload when later chunks exceed the byte limit", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      }
    });
    const guarded = await guardedBodyStream(source, 5, 2);
    await expect(new Response(guarded.body).arrayBuffer()).rejects.toBeInstanceOf(BodyTooLargeError);
    await expect(guarded.completed).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("parses satisfiable single byte ranges", () => {
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ offset: 10, length: 10, contentRange: "bytes 10-19/100" });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10, contentRange: "bytes 90-99/100" });
    expect(parseByteRange("bytes=-12", 100)).toEqual({ offset: 88, length: 12, contentRange: "bytes 88-99/100" });
    expect(parseByteRange("bytes=100-", 100)).toBeNull();
    expect(parseByteRange("bytes=0-1,3-4", 100)).toBeNull();
  });
});

describe("abuse controls", () => {
  it("touches device presence at most once every five minutes", () => {
    const now = Date.parse("2026-08-03T12:05:00.000Z");
    expect(shouldTouchDevice(null, now)).toBe(true);
    expect(shouldTouchDevice("2026-08-03T11:59:59.000Z", now)).toBe(true);
    expect(shouldTouchDevice("2026-08-03T12:01:00.000Z", now)).toBe(false);
  });

  it("enforces upload count and byte budgets independently", () => {
    expect(evaluateQuota({ uploads: 500, bytes: 1 }, 1, 500, 100)).toBe("count");
    expect(evaluateQuota({ uploads: 2, bytes: 90 }, 11, 500, 100)).toBe("bytes");
    expect(evaluateQuota({ uploads: 2, bytes: 90 }, 10, 500, 100)).toBe("accepted");
  });

  it("accepts Turnstile only for the configured production hostname and action", () => {
    const env = { ENVIRONMENT: "production", TURNSTILE_EXPECTED_HOSTNAMES: "zxtoolkit.pages.dev" } as Env;
    expect(isAcceptedResult({ success: true, hostname: "zxtoolkit.pages.dev", action: "turnstile-spin-v1" }, env)).toBe(true);
    expect(isAcceptedResult({ success: true, hostname: "evil.example", action: "turnstile-spin-v1" }, env)).toBe(false);
    expect(isAcceptedResult({ success: true, hostname: "zxtoolkit.pages.dev", action: "other" }, env)).toBe(false);
  });
});
