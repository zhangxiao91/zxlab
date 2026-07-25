import type { DropPayload, DropStatus } from "./types";

export function classifyClipboard(text: string): DropPayload {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") return { type: "url", url: url.toString() };
  } catch { /* plain text */ }
  return { type: "text", text: trimmed };
}

export function validateDropPayload(value: unknown): DropPayload | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  if (value.type === "text" && "text" in value && typeof value.text === "string") {
    const text = value.text.trim();
    return text && text.length <= 20_000 ? { type: "text", text } : null;
  }
  if (value.type === "url" && "url" in value && typeof value.url === "string") {
    try {
      const url = new URL(value.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      const title = "title" in value && typeof value.title === "string" ? value.title.slice(0, 200) : undefined;
      return { type: "url", url: url.toString(), title };
    } catch { return null; }
  }
  if (value.type === "image" && "fileName" in value && "mimeType" in value && "size" in value) {
    const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const fileName = typeof value.fileName === "string" ? value.fileName.trim().slice(0, 180) : "";
    const mimeType = typeof value.mimeType === "string" && allowed.has(value.mimeType) ? value.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif" : null;
    const size = typeof value.size === "number" && Number.isSafeInteger(value.size) ? value.size : 0;
    if (!fileName || !mimeType || size <= 0 || size > 20 * 1024 * 1024) return null;
    const width = "width" in value && typeof value.width === "number" && Number.isSafeInteger(value.width) && value.width > 0 ? value.width : undefined;
    const height = "height" in value && typeof value.height === "number" && Number.isSafeInteger(value.height) && value.height > 0 ? value.height : undefined;
    return { type: "image", fileName, mimeType, size, width, height };
  }
  if (value.type === "file" && "fileName" in value && "mimeType" in value && "size" in value) {
    const fileName = typeof value.fileName === "string" ? safeFileName(value.fileName) : "";
    const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim().toLowerCase().slice(0, 120) : "";
    const size = typeof value.size === "number" && Number.isSafeInteger(value.size) ? value.size : 0;
    if (!fileName || !isSafeFileMime(mimeType) || size <= 0 || size > 20 * 1024 * 1024) return null;
    return { type: "file", fileName, mimeType, size };
  }
  return null;
}

export function isBinaryDropPayload(payload: DropPayload): payload is Extract<DropPayload, { type: "image" | "file" }> {
  return payload.type === "image" || payload.type === "file";
}

export function payloadForFile(file: Pick<File, "name" | "type" | "size">): DropPayload | null {
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const mimeType = file.type || "application/octet-stream";
  if (imageTypes.has(mimeType)) return validateDropPayload({ type: "image", fileName: file.name, mimeType, size: file.size });
  return validateDropPayload({ type: "file", fileName: file.name, mimeType, size: file.size });
}

function safeFileName(value: string): string {
  return value.trim().replace(/[\\/\0\r\n]/g, "_").replace(/^\.+$/, "file").slice(0, 180);
}

function isSafeFileMime(value: string): boolean {
  return Boolean(value) && !value.includes("\r") && !value.includes("\n") && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);
}

export function canAdvanceDropStatus(current: DropStatus, next: "opened" | "claimed"): boolean {
  if (next === "opened") return current === "delivered";
  return current === "delivered" || current === "opened";
}
