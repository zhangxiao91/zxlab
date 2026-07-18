import type { AIMessage, GenerateAIInput } from "../../../src/lib/ai/types.ts";
import { AIError } from "./errors.ts";

export const AI_REQUEST_LIMITS = {
  maxBodyBytes: 128 * 1024,
  maxMessages: 40,
  maxMessageChars: 24_000,
  maxTotalMessageChars: 96_000,
  maxTaskChars: 80,
  maxOutputTokens: 4_000,
} as const;

const allowedInputKeys = new Set(["task", "messages", "temperature", "maxOutputTokens", "responseFormat"]);
const roles = new Set(["system", "user", "assistant"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateGenerateAIInput(value: unknown): GenerateAIInput {
  if (!isRecord(value)) throw new AIError("INVALID_INPUT");
  if (Object.keys(value).some((key) => !allowedInputKeys.has(key))) throw new AIError("INVALID_INPUT");
  if (typeof value.task !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.task) || value.task.length > AI_REQUEST_LIMITS.maxTaskChars) {
    throw new AIError("INVALID_INPUT");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > AI_REQUEST_LIMITS.maxMessages) {
    throw new AIError("INVALID_INPUT");
  }
  let totalChars = 0;
  const messages: AIMessage[] = value.messages.map((message) => {
    if (!isRecord(message) || Object.keys(message).some((key) => key !== "role" && key !== "content")) throw new AIError("INVALID_INPUT");
    if (typeof message.role !== "string" || !roles.has(message.role) || typeof message.content !== "string" || !message.content.trim()) {
      throw new AIError("INVALID_INPUT");
    }
    if (message.content.length > AI_REQUEST_LIMITS.maxMessageChars) throw new AIError("CONTEXT_TOO_LONG");
    totalChars += message.content.length;
    return { role: message.role as AIMessage["role"], content: message.content };
  });
  if (totalChars > AI_REQUEST_LIMITS.maxTotalMessageChars) throw new AIError("CONTEXT_TOO_LONG");
  if (value.temperature !== undefined && (typeof value.temperature !== "number" || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) {
    throw new AIError("INVALID_INPUT");
  }
  if (value.maxOutputTokens !== undefined && (!Number.isInteger(value.maxOutputTokens) || (value.maxOutputTokens as number) < 1 || (value.maxOutputTokens as number) > AI_REQUEST_LIMITS.maxOutputTokens)) {
    throw new AIError("INVALID_INPUT");
  }
  if (value.responseFormat !== undefined && (!isRecord(value.responseFormat) || Object.keys(value.responseFormat).length !== 1 || (value.responseFormat.type !== "text" && value.responseFormat.type !== "json"))) {
    throw new AIError("INVALID_INPUT");
  }
  return {
    task: value.task,
    messages,
    ...(value.temperature === undefined ? {} : { temperature: value.temperature as number }),
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens as number }),
    responseFormat: value.responseFormat as GenerateAIInput["responseFormat"] ?? { type: "text" },
  };
}

export async function readGenerateAIRequest(request: Request): Promise<GenerateAIInput> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new AIError("INVALID_INPUT");
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > AI_REQUEST_LIMITS.maxBodyBytes) throw new AIError("INVALID_INPUT");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > AI_REQUEST_LIMITS.maxBodyBytes) throw new AIError("INVALID_INPUT");
  try {
    return validateGenerateAIInput(JSON.parse(body) as unknown);
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError("INVALID_INPUT", { cause: error });
  }
}
