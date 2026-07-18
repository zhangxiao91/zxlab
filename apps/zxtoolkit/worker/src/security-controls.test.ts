import { describe, expect, it } from "vitest";
import { BodyTooLargeError, declaredBodySize, hasImageSignature, readBodyWithLimit } from "./request-body";
import { isAcceptedResult } from "./turnstile";
import { evaluateQuota } from "./abuse-controls";

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
});

describe("abuse controls", () => {
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
