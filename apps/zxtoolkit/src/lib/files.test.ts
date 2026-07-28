import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE, MAX_TOTAL_SIZE, formatBytes, validateFiles } from "./files";

function fileOfSize(size: number): File {
  const file = new File([new Uint8Array(1)], "sample.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("file limits", () => {
  it("accepts a file within the 100 MB limit", () => {
    expect(validateFiles([fileOfSize(1024)])).toBeNull();
  });

  it("rejects a single oversized file", () => {
    expect(validateFiles([fileOfSize(MAX_FILE_SIZE + 1)])).toContain("100 MB");
  });

  it("rejects a transfer over the total limit", () => {
    const files = Array.from({ length: 3 }, () => fileOfSize(MAX_TOTAL_SIZE / 3 + 1));
    expect(validateFiles(files)).toContain("100 MB");
  });

  it("formats bytes for the transfer UI", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});
