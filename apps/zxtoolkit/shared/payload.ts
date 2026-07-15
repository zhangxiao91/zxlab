import type { DropPayload } from "./types";

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
  return null;
}
