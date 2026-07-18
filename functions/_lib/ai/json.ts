import { AIError } from "./errors.ts";

export function parseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (cause) {
    throw new AIError("INVALID_STRUCTURED_OUTPUT", { cause, fallbackAllowed: true });
  }
}
