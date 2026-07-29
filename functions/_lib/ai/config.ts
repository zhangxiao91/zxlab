import { AIError } from "./errors.ts";
import type { LLMUsageDatabase } from "./telemetry.ts";

export type CapabilityTier = "sol" | "kimi-k3" | "terra" | "deepseek-flash";
export type SelectionSource = "selector" | "task-default" | "selector-fallback";

export interface AIEnv {
  ENVIRONMENT?: string;
  GPT_PROVIDER1_BASE_URL?: string;
  GPT_PROVIDER1_API_KEY?: string;
  GPT_PROVIDER1_SOL_MODEL?: string;
  GPT_PROVIDER1_TERRA_MODEL?: string;
  GPT_PROVIDER2_BASE_URL?: string;
  GPT_PROVIDER2_SOL_API_KEY?: string;
  GPT_PROVIDER2_TERRA_API_KEY?: string;
  GPT_PROVIDER2_SOL_MODEL?: string;
  GPT_PROVIDER2_TERRA_MODEL?: string;
  KIMI_BASE_URL?: string;
  KIMI_API_KEY?: string;
  KIMI_K3_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_FLASH_MODEL?: string;
  AI_GATEWAY_ACCESS_TOKEN?: string;
  AI_GATEWAY_ALLOWED_ORIGINS?: string;
  AI_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  LLM_USAGE_DB?: LLMUsageDatabase;
}

export interface ModelCandidate {
  id: string;
  tier: CapabilityTier;
  provider: string;
  providerInstance: string;
  adapter: "openai-compatible" | "deepseek-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelCatalog {
  tiers: Record<CapabilityTier, ModelCandidate[]>;
  selector: ModelCandidate[];
}

const TIER_ORDER: CapabilityTier[] = ["sol", "kimi-k3", "terra", "deepseek-flash"];

function required(env: AIEnv, key: keyof AIEnv): string {
  const value = env[key];
  if (typeof value !== "string" || !value.trim()) throw new AIError("MISSING_CONFIGURATION");
  return value.trim();
}

function baseUrl(env: AIEnv, key: keyof AIEnv, fallback?: string): string {
  const value = typeof env[key] === "string" && env[key].trim() ? env[key].trim() : fallback;
  if (!value) throw new AIError("MISSING_CONFIGURATION");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("HTTPS required");
    return url.toString().replace(/\/$/, "");
  } catch (cause) {
    throw new AIError("MISSING_CONFIGURATION", { cause });
  }
}

export function getModelCatalog(env: AIEnv): ModelCatalog {
  const gpt1 = baseUrl(env, "GPT_PROVIDER1_BASE_URL");
  const gpt2 = baseUrl(env, "GPT_PROVIDER2_BASE_URL");
  const kimi = baseUrl(env, "KIMI_BASE_URL", "https://api.moonshot.ai/v1");
  const deepseek = baseUrl(env, "DEEPSEEK_BASE_URL", "https://api.deepseek.com");
  const gpt1Key = required(env, "GPT_PROVIDER1_API_KEY");
  const sol1: ModelCandidate = { id: "sol-gpt-provider1", tier: "sol", provider: "gpt", providerInstance: "gpt-provider1",
    adapter: "openai-compatible", model: required(env, "GPT_PROVIDER1_SOL_MODEL"), baseUrl: gpt1, apiKey: gpt1Key };
  const sol2: ModelCandidate = { id: "sol-gpt-provider2", tier: "sol", provider: "gpt", providerInstance: "gpt-provider2",
    adapter: "openai-compatible", model: required(env, "GPT_PROVIDER2_SOL_MODEL"), baseUrl: gpt2, apiKey: required(env, "GPT_PROVIDER2_SOL_API_KEY") };
  const terra1: ModelCandidate = { id: "terra-gpt-provider1", tier: "terra", provider: "gpt", providerInstance: "gpt-provider1",
    adapter: "openai-compatible", model: required(env, "GPT_PROVIDER1_TERRA_MODEL"), baseUrl: gpt1, apiKey: gpt1Key };
  const terra2: ModelCandidate = { id: "terra-gpt-provider2", tier: "terra", provider: "gpt", providerInstance: "gpt-provider2",
    adapter: "openai-compatible", model: required(env, "GPT_PROVIDER2_TERRA_MODEL"), baseUrl: gpt2, apiKey: required(env, "GPT_PROVIDER2_TERRA_API_KEY") };
  const kimiK3: ModelCandidate = { id: "kimi-k3-moonshot", tier: "kimi-k3", provider: "moonshot", providerInstance: "moonshot-official",
    adapter: "openai-compatible", model: required(env, "KIMI_K3_MODEL"), baseUrl: kimi, apiKey: required(env, "KIMI_API_KEY") };
  const flash: ModelCandidate = { id: "deepseek-flash-official", tier: "deepseek-flash", provider: "deepseek", providerInstance: "deepseek-official",
    adapter: "deepseek-compatible", model: env.DEEPSEEK_FLASH_MODEL?.trim() || "deepseek-v4-flash", baseUrl: deepseek, apiKey: required(env, "DEEPSEEK_API_KEY") };
  return {
    tiers: { sol: [sol1, sol2], "kimi-k3": [kimiK3], terra: [terra1, terra2], "deepseek-flash": [flash] },
    selector: [flash, terra1, terra2],
  };
}

export function executionCandidates(catalog: ModelCatalog, selectedTier: CapabilityTier): ModelCandidate[] {
  const start = TIER_ORDER.indexOf(selectedTier);
  if (start < 0) throw new AIError("MISSING_CONFIGURATION");
  return TIER_ORDER.slice(start).flatMap((tier) => catalog.tiers[tier]);
}

/** Compatibility seam for injected tests and callers that explicitly request the complete chain. */
export function getDefaultModelChain(env: AIEnv): ModelCandidate[] {
  return executionCandidates(getModelCatalog(env), "sol");
}
