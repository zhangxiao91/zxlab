import { AIError } from "./errors.ts";
import type { LLMUsageDatabase } from "./telemetry.ts";

export type CapabilityTier = "deepseek-flash" | "kimi-k3" | "openai-text";

export interface AIEnv {
  ENVIRONMENT?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_FLASH_MODEL?: string;
  KIMI_BASE_URL?: string;
  KIMI_API_KEY?: string;
  KIMI_MODEL?: string;
  KIMI_K3_MODEL?: string;
  OPENAI_TEXT_BASE_URL?: string;
  OPENAI_TEXT_API_KEY?: string;
  OPENAI_TEXT_MODEL?: string;
  MARKET_AGENT_OPENAI_FALLBACK_MODEL?: string;
  AI_GATEWAY_ACCESS_TOKEN?: string;
  MARKET_AGENT_GATEWAY_TOKEN?: string;
  ZX_RUNTIME_SERVICE_TOKEN?: string;
  ZX_SIGNAL_PREVIEW_SERVICE_TOKEN?: string;
  AI_GATEWAY_ALLOWED_ORIGINS?: string;
  AI_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  LLM_USAGE_DB?: LLMUsageDatabase;
}

export interface ModelCandidate {
  id: string;
  tier: CapabilityTier;
  provider: "deepseek" | "moonshot" | "openai";
  providerInstance: "deepseek-official" | "moonshot-official" | "openai-text-configured";
  adapter: "openai-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
}

const OFFICIAL_MODELS = {
  deepseek: {
    id: "deepseek-v4-flash-official",
    tier: "deepseek-flash",
    provider: "deepseek",
    providerInstance: "deepseek-official",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
  },
  kimi: {
    id: "kimi-k3-official",
    tier: "kimi-k3",
    provider: "moonshot",
    providerInstance: "moonshot-official",
    model: "kimi-k3",
    baseUrl: "https://api.moonshot.ai/v1",
  },
} as const;

function configured(env: AIEnv, key: keyof AIEnv): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("HTTPS required");
    }
    return url.toString().replace(/\/$/, "");
  } catch (cause) {
    throw new AIError("MISSING_CONFIGURATION", { cause });
  }
}

function officialBaseUrl(env: AIEnv, key: keyof AIEnv, fallback: string): string {
  return normalizedBaseUrl(configured(env, key) ?? fallback);
}

/** Fixed production route: DeepSeek first, then Kimi, then the configured OpenAI text fallback. */
export function getDefaultModelChain(env: AIEnv): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];
  const deepseekKey = configured(env, "DEEPSEEK_API_KEY");
  if (deepseekKey) {
    candidates.push({
      ...OFFICIAL_MODELS.deepseek,
      adapter: "openai-compatible",
      model: configured(env, "DEEPSEEK_MODEL") ?? configured(env, "DEEPSEEK_FLASH_MODEL") ?? OFFICIAL_MODELS.deepseek.model,
      baseUrl: officialBaseUrl(env, "DEEPSEEK_BASE_URL", OFFICIAL_MODELS.deepseek.baseUrl),
      apiKey: deepseekKey,
    });
  }

  const kimiKey = configured(env, "KIMI_API_KEY");
  if (kimiKey) {
    candidates.push({
      ...OFFICIAL_MODELS.kimi,
      adapter: "openai-compatible",
      model: configured(env, "KIMI_MODEL") ?? configured(env, "KIMI_K3_MODEL") ?? OFFICIAL_MODELS.kimi.model,
      baseUrl: officialBaseUrl(env, "KIMI_BASE_URL", OFFICIAL_MODELS.kimi.baseUrl),
      apiKey: kimiKey,
    });
  }

  const openAITextKey = configured(env, "OPENAI_TEXT_API_KEY");
  const openAITextBaseUrl = configured(env, "OPENAI_TEXT_BASE_URL");
  const openAITextModel = configured(env, "OPENAI_TEXT_MODEL");
  if (openAITextKey && openAITextBaseUrl && openAITextModel) {
    candidates.push({
      id: "openai-text-configured",
      tier: "openai-text",
      provider: "openai",
      providerInstance: "openai-text-configured",
      adapter: "openai-compatible",
      model: openAITextModel,
      baseUrl: normalizedBaseUrl(openAITextBaseUrl),
      apiKey: openAITextKey,
    });
  }

  if (candidates.length === 0) throw new AIError("MISSING_CONFIGURATION");
  return candidates;
}

export function getMarketAgentOpenAIFallback(env: AIEnv): ModelCandidate | undefined {
  const apiKey = configured(env, "OPENAI_TEXT_API_KEY");
  const baseUrl = configured(env, "OPENAI_TEXT_BASE_URL");
  const model = configured(env, "MARKET_AGENT_OPENAI_FALLBACK_MODEL");
  if (!apiKey || !baseUrl || !model || model === configured(env, "OPENAI_TEXT_MODEL")) return undefined;
  return {
    id: "market-agent-openai-fallback",
    tier: "openai-text",
    provider: "openai",
    providerInstance: "openai-text-configured",
    adapter: "openai-compatible",
    model,
    baseUrl: normalizedBaseUrl(baseUrl),
    apiKey,
  };
}
