import type { GenerateAIInput } from "../../../src/lib/ai/types.ts";
import type { CapabilityTier, ModelCandidate, ModelCatalog, SelectionSource } from "./config.ts";
import { AIError, asAIError } from "./errors.ts";
import { parseStructuredOutput } from "./json.ts";
import type { AIProviderAdapter } from "./providers/types.ts";

export type SelectionReason =
  | "complex-reasoning"
  | "long-context"
  | "structured-generation"
  | "creative-generation"
  | "classification"
  | "simple-extraction"
  | "task-default";

export interface ModelSelection {
  tier: CapabilityTier;
  confidence: number;
  reasonCode: SelectionReason;
  source: SelectionSource;
  selectorProvider?: string;
  selectorModel?: string;
  selectorFallbackUsed: boolean;
  selectorAttempts: number;
  selectorTrace: Array<{ candidateId: string; providerInstance: string; status: "success" | "error"; errorCode?: string; latencyMs: number }>;
}

export interface SelectorDependencies {
  adapters: Record<ModelCandidate["adapter"], AIProviderAdapter>;
  fetcher: typeof fetch;
  requestId: string;
  signal?: AbortSignal;
}

const TIERS = new Set<CapabilityTier>(["sol", "kimi-k3", "terra", "deepseek-flash"]);
const REASONS = new Set<SelectionReason>(["complex-reasoning", "long-context", "structured-generation", "creative-generation", "classification", "simple-extraction"]);

export function defaultTierForTask(task: string): CapabilityTier {
  if (task === "signal-editorial-filter" || task === "signal-memory-extraction" || task === "signal-memory-consolidation"
    || task === "holdings-parse") return "deepseek-flash";
  if (task === "signal-annotation-reply" || task === "notes-summary") return "terra";
  if (task === "yuzi-turn" || task === "signal-briefing" || task === "portfolio-review") return "kimi-k3";
  return "terra";
}

function selectorRequired(task: string): boolean {
  return !["signal-editorial-filter", "signal-memory-extraction", "signal-memory-consolidation", "holdings-parse"].includes(task);
}

function selectorInput(input: GenerateAIInput): GenerateAIInput {
  const excerpt = input.messages.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 2_400);
  return {
    task: "gateway-model-selector",
    messages: [
      { role: "system", content: "Select the least expensive capability tier that can reliably complete the request. Return JSON only." },
      { role: "user", content: JSON.stringify({
        task: input.task,
        responseFormat: input.responseFormat?.type ?? "text",
        maxOutputTokens: input.maxOutputTokens,
        inputChars: input.messages.reduce((sum, message) => sum + message.content.length, 0),
        excerpt,
        tiers: ["sol", "kimi-k3", "terra", "deepseek-flash"],
        schema: { tier: "tier enum", confidence: "0..1", reasonCode: "reason enum" },
      }) },
    ],
    temperature: 0,
    maxOutputTokens: 120,
    responseFormat: { type: "json" },
  };
}

function parseSelection(text: string): Pick<ModelSelection, "tier" | "confidence" | "reasonCode"> {
  const value = parseStructuredOutput(text) as Record<string, unknown>;
  if (!TIERS.has(value.tier as CapabilityTier) || typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1
    || !REASONS.has(value.reasonCode as SelectionReason)) throw new AIError("INVALID_STRUCTURED_OUTPUT", { fallbackAllowed: true });
  return { tier: value.tier as CapabilityTier, confidence: value.confidence, reasonCode: value.reasonCode as SelectionReason };
}

export async function selectModelTier(input: GenerateAIInput, catalog: ModelCatalog, dependencies: SelectorDependencies): Promise<ModelSelection> {
  const fallbackTier = defaultTierForTask(input.task);
  if (!selectorRequired(input.task)) {
    return { tier: fallbackTier, confidence: 1, reasonCode: "task-default", source: "task-default", selectorFallbackUsed: false, selectorAttempts: 0, selectorTrace: [] };
  }
  let attempts = 0;
  const selectorTrace: ModelSelection["selectorTrace"] = [];
  for (const candidate of catalog.selector) {
    attempts += 1;
    const startedAt = Date.now();
    try {
      const result = await dependencies.adapters[candidate.adapter].generate(candidate, selectorInput(input), {
        requestId: `${dependencies.requestId}-selector-${attempts}`,
        timeoutMs: 5_000,
        fetcher: dependencies.fetcher,
        signal: dependencies.signal,
      });
      selectorTrace.push({ candidateId: candidate.id, providerInstance: candidate.providerInstance, status: "success", latencyMs: Date.now() - startedAt });
      return {
        ...parseSelection(result.text),
        source: "selector",
        selectorProvider: candidate.providerInstance,
        selectorModel: candidate.model,
        selectorFallbackUsed: attempts > 1,
        selectorAttempts: attempts,
        selectorTrace,
      };
    } catch (cause) {
      const error = asAIError(cause);
      selectorTrace.push({ candidateId: candidate.id, providerInstance: candidate.providerInstance, status: "error", errorCode: error.code, latencyMs: Date.now() - startedAt });
      if (!error.fallbackAllowed && error.code !== "INVALID_STRUCTURED_OUTPUT") break;
    }
  }
  return { tier: fallbackTier, confidence: 0, reasonCode: "task-default", source: "selector-fallback", selectorFallbackUsed: true, selectorAttempts: attempts, selectorTrace };
}
