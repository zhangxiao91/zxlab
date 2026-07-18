import { SignalError } from "../../lib/errors";
import { feedbackActions, memoryKinds, memoryNamespaces, type FeedbackAction, type MemoryKind, type MemoryNamespace, type RetrieveMemoryInput } from "./types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SignalError("INVALID_REQUEST", "Request body must be an object", 400);
  return value as JsonObject;
}

function text(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new SignalError("INVALID_REQUEST", `${field} must be a non-empty string`, 400);
  return value.trim();
}

function score(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new SignalError("INVALID_REQUEST", `${field} must be between 0 and 1`, 400);
  return value;
}

function timestamp(value: unknown, field: string): string | undefined {
  const parsed = text(value, field, 64, true);
  if (!parsed) return undefined;
  const time = Date.parse(parsed);
  if (Number.isNaN(time)) throw new SignalError("INVALID_REQUEST", `${field} must be an ISO timestamp`, 400);
  return new Date(time).toISOString();
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new SignalError("INVALID_REQUEST", `${field} is invalid`, 400);
  return value as T[number];
}

export function parseFeedbackEvent(value: unknown): { targetType: string; targetId: string; action: FeedbackAction; comment?: string } {
  const input = object(value);
  return {
    targetType: text(input.targetType, "targetType", 80)!,
    targetId: text(input.targetId, "targetId", 160)!,
    action: enumValue(input.action, feedbackActions, "action"),
    comment: text(input.comment, "comment", 2_000, true),
  };
}

export function parseCreateMemory(value: unknown): { namespace: MemoryNamespace; kind: MemoryKind; content: string; importance: number; confidence: number; sourceType: string; sourceId?: string; expiresAt?: string } {
  const input = object(value);
  return {
    namespace: enumValue(input.namespace, memoryNamespaces, "namespace"),
    kind: enumValue(input.kind, memoryKinds, "kind"),
    content: text(input.content, "content", 8_000)!,
    importance: score(input.importance, "importance", 0.5),
    confidence: score(input.confidence, "confidence", 0.5),
    sourceType: text(input.sourceType, "sourceType", 80)!,
    sourceId: text(input.sourceId, "sourceId", 160, true),
    expiresAt: timestamp(input.expiresAt, "expiresAt"),
  };
}

export function parseUpdateMemory(value: unknown): Partial<ReturnType<typeof parseCreateMemory>> & { reason: string } {
  const input = object(value);
  const result: Partial<ReturnType<typeof parseCreateMemory>> & { reason: string } = { reason: text(input.reason, "reason", 1_000)! };
  if (input.namespace !== undefined) result.namespace = enumValue(input.namespace, memoryNamespaces, "namespace");
  if (input.kind !== undefined) result.kind = enumValue(input.kind, memoryKinds, "kind");
  if (input.content !== undefined) result.content = text(input.content, "content", 8_000)!;
  if (input.importance !== undefined) result.importance = score(input.importance, "importance");
  if (input.confidence !== undefined) result.confidence = score(input.confidence, "confidence");
  if (input.sourceType !== undefined) result.sourceType = text(input.sourceType, "sourceType", 80)!;
  if (input.sourceId !== undefined) result.sourceId = text(input.sourceId, "sourceId", 160, true);
  if (input.expiresAt !== undefined) result.expiresAt = timestamp(input.expiresAt, "expiresAt");
  return result;
}

export function parseRetrieveMemory(value: unknown): RetrieveMemoryInput {
  const input = object(value);
  if (!Array.isArray(input.namespaces) || input.namespaces.length === 0 || input.namespaces.length > memoryNamespaces.length) {
    throw new SignalError("INVALID_REQUEST", "namespaces must be a non-empty array", 400);
  }
  const namespaces = [...new Set(input.namespaces.map((item) => enumValue(item, memoryNamespaces, "namespaces")))];
  const limit = input.limit === undefined ? 12 : input.limit;
  const tokenBudget = input.tokenBudget === undefined ? 1_500 : input.tokenBudget;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new SignalError("INVALID_REQUEST", "limit must be between 1 and 100", 400);
  if (!Number.isInteger(tokenBudget) || (tokenBudget as number) < 64 || (tokenBudget as number) > 16_000) throw new SignalError("INVALID_REQUEST", "tokenBudget must be between 64 and 16000", 400);
  return {
    task: text(input.task, "task", 120)!,
    namespaces,
    query: text(input.query, "query", 8_000)!,
    limit: limit as number,
    tokenBudget: tokenBudget as number,
  };
}

export function parseConsolidationRequest(value: unknown): { limit: number } {
  const input = object(value);
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new SignalError("INVALID_REQUEST", "limit must be between 1 and 200", 400);
  return { limit: limit as number };
}
