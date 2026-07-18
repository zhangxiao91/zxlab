import { AIError } from "./errors.ts";
import type { LLMUsageDatabase } from "./telemetry.ts";

export interface AIEnv {
  ENVIRONMENT?: string;
  PROVIDER1_BASE_URL?: string;
  PROVIDER1_API_KEY?: string;
  PROVIDER1_GPT56_MODEL?: string;
  PROVIDER1_GPT55_MODEL?: string;
  PROVIDER2_BASE_URL?: string;
  PROVIDER2_API_KEY?: string;
  PROVIDER2_GPT55_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_V4_PRO_MODEL?: string;
  AI_GATEWAY_ACCESS_TOKEN?: string;
  AI_GATEWAY_ALLOWED_ORIGINS?: string;
  AI_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  LLM_USAGE_DB?: LLMUsageDatabase;
}

export interface ModelCandidate {
  id: string;
  provider: "provider1" | "provider2" | "deepseek";
  adapter: "openai-compatible" | "deepseek-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
}

function required(env: AIEnv, key: keyof AIEnv): string {
  const value = env[key];
  if (typeof value !== "string" || !value.trim()) throw new AIError("MISSING_CONFIGURATION");
  return value.trim();
}

function baseUrl(env: AIEnv, key: keyof AIEnv): string {
  const value = required(env, key);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("HTTPS required");
    return url.toString().replace(/\/$/, "");
  } catch (cause) {
    throw new AIError("MISSING_CONFIGURATION", { cause });
  }
}

export function getDefaultModelChain(env: AIEnv): ModelCandidate[] {
  const provider1BaseUrl = baseUrl(env, "PROVIDER1_BASE_URL");
  const provider1ApiKey = required(env, "PROVIDER1_API_KEY");
  const provider2BaseUrl = baseUrl(env, "PROVIDER2_BASE_URL");
  const provider2ApiKey = required(env, "PROVIDER2_API_KEY");
  const deepseekBaseUrl = baseUrl(env, "DEEPSEEK_BASE_URL");
  const deepseekApiKey = required(env, "DEEPSEEK_API_KEY");
  return [
    { id: "provider1-gpt-5.6", provider: "provider1", adapter: "openai-compatible", model: required(env, "PROVIDER1_GPT56_MODEL"), baseUrl: provider1BaseUrl, apiKey: provider1ApiKey },
    { id: "provider1-gpt-5.5", provider: "provider1", adapter: "openai-compatible", model: required(env, "PROVIDER1_GPT55_MODEL"), baseUrl: provider1BaseUrl, apiKey: provider1ApiKey },
    { id: "provider2-gpt-5.5", provider: "provider2", adapter: "openai-compatible", model: required(env, "PROVIDER2_GPT55_MODEL"), baseUrl: provider2BaseUrl, apiKey: provider2ApiKey },
    { id: "deepseek-v4-pro", provider: "deepseek", adapter: "deepseek-compatible", model: required(env, "DEEPSEEK_V4_PRO_MODEL"), baseUrl: deepseekBaseUrl, apiKey: deepseekApiKey },
  ];
}
