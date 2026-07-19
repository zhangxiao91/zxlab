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
  return null;
}

export function canAdvanceDropStatus(current: DropStatus, next: "opened" | "claimed"): boolean {
  if (next === "opened") return current === "delivered";
  return current === "delivered" || current === "opened";
}
