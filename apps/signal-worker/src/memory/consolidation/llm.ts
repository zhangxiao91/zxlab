import { SignalError } from "../../lib/errors";
import { ModelInvocationRepository } from "../../repositories/model-invocation-repository";
import { requestGatewayJson, responseValue } from "../../services/gateway-client";
import { memoryKinds, memoryNamespaces, type ConsolidationCandidate, type FeedbackEvent, type MemoryItem } from "../schema/types";
import { buildConsolidationPrompt, consolidationJsonSchema, CONSOLIDATION_PROMPT_VERSION } from "./prompt";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class MemoryConsolidationLLM {
  private readonly invocations: ModelInvocationRepository;
  constructor(private readonly env: Env, private readonly fetcher: typeof fetch = fetch) {
    this.invocations = new ModelInvocationRepository(env.DB);
  }

  async propose(events: FeedbackEvent[], memories: MemoryItem[]): Promise<Array<Omit<ConsolidationCandidate, "id" | "status" | "createdAt" | "resolvedAt">>> {
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.invocations.start({ id: invocationId, task: "memory-consolidation", model: this.env.ZX_SIGNAL_LLM_LABEL,
      promptVersion: CONSOLIDATION_PROMPT_VERSION, startedAt });
    try {
      const prompt = buildConsolidationPrompt(events, memories);
      const result = await requestGatewayJson({
        fetcher: this.fetcher,
        apiUrl: this.env.ZX_SIGNAL_LLM_API_URL,
        token: this.env.ZX_SIGNAL_LLM_API_TOKEN,
        invocationId,
        body: {
          task: "signal-memory-consolidation",
          messages: [
            { role: "system", content: `${prompt.system}\nThe output JSON must match this schema exactly: ${JSON.stringify(consolidationJsonSchema)}` },
            { role: "user", content: prompt.user },
          ],
          temperature: 0,
          maxOutputTokens: 1_600,
          responseFormat: { type: "json" },
        },
      });
      const parsed = this.validate(responseValue(result), events, memories);
      await this.invocations.complete(invocationId, {
        model: `${result.data.provider}/${result.data.model}`,
        inputTokens: result.data.usage?.inputTokens,
        outputTokens: result.data.usage?.outputTokens,
      });
      return parsed;
    } catch (cause) {
      await this.invocations.fail(invocationId, "INVALID_MODEL_OUTPUT");
      throw new SignalError("MODEL_REQUEST_FAILED", "Memory consolidation failed", 502, cause);
    }
  }

  private validate(value: unknown, events: FeedbackEvent[], memories: MemoryItem[]): Array<Omit<ConsolidationCandidate, "id" | "status" | "createdAt" | "resolvedAt">> {
    const root = object(value);
    if (!Array.isArray(root?.candidates) || root.candidates.length > 20) throw new Error("Invalid consolidation candidates");
    const eventIds = new Set(events.map((event) => event.id));
    const memoryIds = new Set(memories.map((memory) => memory.id));
    return root.candidates.map((raw) => {
      const item = object(raw);
      if (!item || (item.action !== "create" && item.action !== "update" && item.action !== "ignore") || typeof item.reason !== "string" || !item.reason.trim()) throw new Error("Invalid consolidation candidate");
      if (!Array.isArray(item.sourceEventIds) || item.sourceEventIds.length === 0 || item.sourceEventIds.some((id) => typeof id !== "string" || !eventIds.has(id))) throw new Error("Invalid consolidation sources");
      const sourceEventIds = [...new Set(item.sourceEventIds as string[])];
      if (item.action === "ignore") return { action: item.action, reason: item.reason.trim(), sourceEventIds };
      if (!memoryNamespaces.includes(item.namespace as never) || !memoryKinds.includes(item.kind as never) || typeof item.content !== "string" || !item.content.trim()
        || typeof item.importance !== "number" || item.importance < 0 || item.importance > 1
        || typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) throw new Error("Invalid proposed memory");
      const memoryId = typeof item.memoryId === "string" ? item.memoryId : undefined;
      if (item.action === "update" && (!memoryId || !memoryIds.has(memoryId))) throw new Error("Invalid update target");
      return { action: item.action, reason: item.reason.trim(), memoryId, sourceEventIds,
        memory: { namespace: item.namespace as MemoryItem["namespace"], kind: item.kind as MemoryItem["kind"], content: item.content.trim(),
          importance: item.importance, confidence: item.confidence } };
    });
  }
}
