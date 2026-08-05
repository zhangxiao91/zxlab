import { AIError } from "./errors.ts";
import type { LLMUsageDatabase } from "./telemetry.ts";

export type CapabilityTier = "deepseek-flash" | "kimi-k3";

export interface AIEnv {
  ENVIRONMENT?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  KIMI_BASE_URL?: string;
  KIMI_API_KEY?: string;
  KIMI_MODEL?: string;
  AI_GATEWAY_ACCESS_TOKEN?: string;
  MARKET_AGENT_GATEWAY_TOKEN?: string;
  AI_GATEWAY_ALLOWED_ORIGINS?: string;
  AI_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  LLM_USAGE_DB?: LLMUsageDatabase;
}

export interface ModelCandidate {
  id: string;
  tier: CapabilityTier;
  provider: "deepseek" | "moonshot";
  providerInstance: "deepseek-official" | "moonshot-official";
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

function officialBaseUrl(env: AIEnv, key: keyof AIEnv, fallback: string): string {
  const value = configured(env, key) ?? fallback;
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

/** Fixed production route: DeepSeek V4 Flash first, Kimi K3 only on failure. */
export function getDefaultModelChain(env: AIEnv): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];
  const deepseekKey = configured(env, "DEEPSEEK_API_KEY");
  if (deepseekKey) {
    candidates.push({
      ...OFFICIAL_MODELS.deepseek,
      adapter: "openai-compatible",
      model: configured(env, "DEEPSEEK_MODEL") ?? OFFICIAL_MODELS.deepseek.model,
      baseUrl: officialBaseUrl(env, "DEEPSEEK_BASE_URL", OFFICIAL_MODELS.deepseek.baseUrl),
      apiKey: deepseekKey,
    });
  }

  const kimiKey = configured(env, "KIMI_API_KEY");
  if (kimiKey) {
    candidates.push({
      ...OFFICIAL_MODELS.kimi,
      adapter: "openai-compatible",
      model: configured(env, "KIMI_MODEL") ?? OFFICIAL_MODELS.kimi.model,
      baseUrl: officialBaseUrl(env, "KIMI_BASE_URL", OFFICIAL_MODELS.kimi.baseUrl),
      apiKey: kimiKey,
    });
  }

  if (candidates.length === 0) throw new AIError("MISSING_CONFIGURATION");
  return candidates;
}
