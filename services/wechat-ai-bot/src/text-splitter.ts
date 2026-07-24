const SENTENCE_ENDINGS = new Set(["。", "！", "？", ".", "!", "?"]);

function lastPreferredBreak(chars: string[], limit: number): number {
  for (let index = limit; index > 0; index -= 1) {
    if (chars[index - 1] === "\n") return index;
  }
  for (let index = limit; index > 0; index -= 1) {
    if (SENTENCE_ENDINGS.has(chars[index - 1] ?? "")) return index;
  }
  return limit;
}

export function splitText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("maxChars must be a positive integer");
  const remaining = Array.from(text);
  const chunks: string[] = [];

  while (remaining.length > maxChars) {
    const breakAt = lastPreferredBreak(remaining, maxChars);
    chunks.push(remaining.splice(0, breakAt).join(""));
  }
  if (remaining.length > 0 || chunks.length === 0) chunks.push(remaining.join(""));
  return chunks;
}
