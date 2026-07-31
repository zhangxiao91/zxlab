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

function configured(env: AIEnv, key: keyof AIEnv): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function baseUrl(env: AIEnv, key: keyof AIEnv, fallback?: string): string {
  const value = configured(env, key) ?? fallback;
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
  const sol: ModelCandidate[] = [];
  const kimiK3: ModelCandidate[] = [];
  const terra: ModelCandidate[] = [];
  const flash: ModelCandidate[] = [];

  const gpt1Key = configured(env, "GPT_PROVIDER1_API_KEY");
  const gpt1SolModel = configured(env, "GPT_PROVIDER1_SOL_MODEL");
  const gpt1TerraModel = configured(env, "GPT_PROVIDER1_TERRA_MODEL");
  if (gpt1Key && (gpt1SolModel || gpt1TerraModel)) {
    const gpt1 = baseUrl(env, "GPT_PROVIDER1_BASE_URL");
    if (gpt1SolModel) sol.push({ id: "sol-gpt-provider1", tier: "sol", provider: "gpt", providerInstance: "gpt-provider1",
      adapter: "openai-compatible", model: gpt1SolModel, baseUrl: gpt1, apiKey: gpt1Key });
    if (gpt1TerraModel) terra.push({ id: "terra-gpt-provider1", tier: "terra", provider: "gpt", providerInstance: "gpt-provider1",
      adapter: "openai-compatible", model: gpt1TerraModel, baseUrl: gpt1, apiKey: gpt1Key });
  }

  const gpt2SolKey = configured(env, "GPT_PROVIDER2_SOL_API_KEY");
  const gpt2TerraKey = configured(env, "GPT_PROVIDER2_TERRA_API_KEY");
  const gpt2SolModel = configured(env, "GPT_PROVIDER2_SOL_MODEL");
  const gpt2TerraModel = configured(env, "GPT_PROVIDER2_TERRA_MODEL");
  if ((gpt2SolKey && gpt2SolModel) || (gpt2TerraKey && gpt2TerraModel)) {
    const gpt2 = baseUrl(env, "GPT_PROVIDER2_BASE_URL");
    if (gpt2SolKey && gpt2SolModel) sol.push({ id: "sol-gpt-provider2", tier: "sol", provider: "gpt", providerInstance: "gpt-provider2",
      adapter: "openai-compatible", model: gpt2SolModel, baseUrl: gpt2, apiKey: gpt2SolKey });
    if (gpt2TerraKey && gpt2TerraModel) terra.push({ id: "terra-gpt-provider2", tier: "terra", provider: "gpt", providerInstance: "gpt-provider2",
      adapter: "openai-compatible", model: gpt2TerraModel, baseUrl: gpt2, apiKey: gpt2TerraKey });
  }

  const kimiKey = configured(env, "KIMI_API_KEY");
  const kimiModel = configured(env, "KIMI_K3_MODEL");
  if (kimiKey && kimiModel) kimiK3.push({ id: "kimi-k3-moonshot", tier: "kimi-k3", provider: "moonshot", providerInstance: "moonshot-official",
    adapter: "openai-compatible", model: kimiModel, baseUrl: baseUrl(env, "KIMI_BASE_URL", "https://api.moonshot.ai/v1"), apiKey: kimiKey });

  const deepseekKey = configured(env, "DEEPSEEK_API_KEY");
  if (deepseekKey) flash.push({ id: "deepseek-flash-official", tier: "deepseek-flash", provider: "deepseek", providerInstance: "deepseek-official",
    adapter: "deepseek-compatible", model: configured(env, "DEEPSEEK_FLASH_MODEL") ?? "deepseek-v4-flash",
    baseUrl: baseUrl(env, "DEEPSEEK_BASE_URL", "https://api.deepseek.com"), apiKey: deepseekKey });

  const tiers = { sol, "kimi-k3": kimiK3, terra, "deepseek-flash": flash };
  if (TIER_ORDER.every((tier) => tiers[tier].length === 0)) throw new AIError("MISSING_CONFIGURATION");
  return { tiers, selector: [...flash, ...terra] };
}

export function executionCandidates(catalog: ModelCatalog, selectedTier: CapabilityTier): ModelCandidate[] {
  const start = TIER_ORDER.indexOf(selectedTier);
  if (start < 0) throw new AIError("MISSING_CONFIGURATION");
  const preferred = TIER_ORDER.slice(start).flatMap((tier) => catalog.tiers[tier]);
  if (preferred.length > 0) return preferred;
  return TIER_ORDER.slice(0, start).reverse().flatMap((tier) => catalog.tiers[tier]);
}

/** Compatibility seam for injected tests and callers that explicitly request the complete chain. */
export function getDefaultModelChain(env: AIEnv): ModelCandidate[] {
  return executionCandidates(getModelCatalog(env), "sol");
}
