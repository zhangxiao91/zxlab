export interface CodexUsageEnv {
  CODEX_USAGE_API_URL?: string;
  CODEX_USAGE_API_TOKEN?: string;
  CODEX_USAGE_CACHE_TTL?: string;
  CODEX_USAGE_STALE_TTL?: string;
  CODEX_USAGE_REQUEST_TIMEOUT?: string;
}

export interface CodexUsageResponse {
  status: "online" | "stale" | "offline" | "error";
  updatedAt: string;
  limits: Array<{
    id: string;
    label: string;
    usedPercent: number | null;
    windowMinutes: number | null;
    resetsAt: string | null;
  }>;
  tokenSummary: {
    lifetimeTokens: number | null;
    todayTokens: number | null;
    peakDailyTokens: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
  };
  dailyUsage: Array<{
    date: string;
    tokens: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  }>;
  error?: { code: string; message: string };
}

const statusValues = new Set(["online", "stale", "offline", "error"]);
const finiteOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const safeText = (value: unknown, fallback: string, length = 80) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, length) : fallback;
const isoOrNull = (value: unknown) => {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
};

export function sanitizeCodexUsage(value: unknown): CodexUsageResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage response");
  const input = value as Record<string, unknown>;
  const summary = input.tokenSummary && typeof input.tokenSummary === "object"
    ? input.tokenSummary as Record<string, unknown> : {};
  const limits = Array.isArray(input.limits) ? input.limits.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const limit = item as Record<string, unknown>;
    return [{
      id: safeText(limit.id, `limit-${index + 1}`, 64),
      label: safeText(limit.label, "Codex limit", 80),
      usedPercent: finiteOrNull(limit.usedPercent),
      windowMinutes: finiteOrNull(limit.windowMinutes),
      resetsAt: isoOrNull(limit.resetsAt),
    }];
  }) : [];
  const dailyUsage = Array.isArray(input.dailyUsage) ? input.dailyUsage.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const point = item as Record<string, unknown>;
    if (typeof point.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) return [];
    const tokens = finiteOrNull(point.tokens);
    if (tokens === null) return [];
    return [{ date: point.date, tokens }];
  }).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const status = typeof input.status === "string" && statusValues.has(input.status)
    ? input.status as CodexUsageResponse["status"] : "error";
  return {
    status,
    updatedAt: isoOrNull(input.updatedAt) ?? new Date().toISOString(),
    limits,
    tokenSummary: {
      lifetimeTokens: finiteOrNull(summary.lifetimeTokens),
      todayTokens: finiteOrNull(summary.todayTokens),
      peakDailyTokens: finiteOrNull(summary.peakDailyTokens),
      currentStreakDays: finiteOrNull(summary.currentStreakDays),
      longestStreakDays: finiteOrNull(summary.longestStreakDays),
    },
    dailyUsage,
    ...(input.error && typeof input.error === "object" ? {
      error: {
        code: safeText((input.error as Record<string, unknown>).code, "UPSTREAM_ERROR", 48),
        message: safeText((input.error as Record<string, unknown>).message, "Codex usage is unavailable.", 180),
      },
    } : {}),
  };
}

export function asStaleUsage(value: CodexUsageResponse): CodexUsageResponse {
  return { ...value, status: "stale" };
}

export async function fetchCodexUsage(
  env: CodexUsageEnv,
  fetcher: typeof fetch = fetch,
): Promise<CodexUsageResponse> {
  if (!env.CODEX_USAGE_API_URL || !env.CODEX_USAGE_API_TOKEN) throw new Error("Codex usage is not configured");
  const controller = new AbortController();
  const timeout = Number(env.CODEX_USAGE_REQUEST_TIMEOUT || 8) * 1000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(new URL("/v1/usage", env.CODEX_USAGE_API_URL), {
      headers: { Authorization: `Bearer ${env.CODEX_USAGE_API_TOKEN}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Collector returned ${response.status}`);
    return sanitizeCodexUsage(await response.json());
  } finally { clearTimeout(timer); }
}

export async function fetchCodexHealth(env: CodexUsageEnv, fetcher: typeof fetch = fetch) {
  if (!env.CODEX_USAGE_API_URL) throw new Error("Codex usage is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.CODEX_USAGE_REQUEST_TIMEOUT || 8) * 1000);
  try {
    const response = await fetcher(new URL("/health", env.CODEX_USAGE_API_URL), { signal: controller.signal });
    if (!response.ok) throw new Error(`Collector health returned ${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    return {
      status: safeText(value.status, "unknown", 24),
      version: safeText(value.version, "unknown", 24),
      appServer: safeText(value.appServer, "unknown", 24),
      lastSuccessAt: typeof value.lastSuccessAt === "string" ? value.lastSuccessAt : null,
    };
  } finally { clearTimeout(timer); }
}
