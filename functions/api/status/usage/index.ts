import { asStaleUsage, fetchCodexUsage } from "../../../_lib/codex-usage";
import type { CodexUsageEnv, CodexUsageResponse } from "../../../_lib/codex-usage";

interface FunctionContext {
  request: Request;
  env: CodexUsageEnv;
  waitUntil(promise: Promise<unknown>): void;
}

const baseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const json = (data: unknown, status = 200, cacheControl = "no-store") => new Response(JSON.stringify(data), {
  status,
  headers: { ...baseHeaders, "Cache-Control": cacheControl },
});

export const onRequestGet = async (context: FunctionContext) => {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const requestUrl = new URL(context.request.url);
  const freshKey = new Request(`${requestUrl.origin}${requestUrl.pathname}?cache=fresh`);
  const staleKey = new Request(`${requestUrl.origin}${requestUrl.pathname}?cache=stale`);
  const fresh = await cache.match(freshKey);
  if (fresh) return fresh;

  const freshSeconds = Math.max(30, Number(context.env.CODEX_USAGE_CACHE_TTL || 120));
  const staleSeconds = Math.max(freshSeconds, Number(context.env.CODEX_USAGE_STALE_TTL || 21600));
  try {
    const payload = await fetchCodexUsage(context.env);
    const freshResponse = json(payload, 200, `public, max-age=30, s-maxage=${freshSeconds}`);
    const staleResponse = json(payload, 200, `public, s-maxage=${staleSeconds}`);
    context.waitUntil(Promise.all([
      cache.put(freshKey, freshResponse.clone()),
      cache.put(staleKey, staleResponse.clone()),
    ]));
    return freshResponse;
  } catch {
    const fallback = await cache.match(staleKey);
    if (fallback) {
      const payload = asStaleUsage(await fallback.json() as CodexUsageResponse);
      return json(payload, 200, "public, max-age=15, s-maxage=30");
    }
    return json({
      status: "offline",
      updatedAt: new Date().toISOString(),
      limits: [],
      tokenSummary: {
        lifetimeTokens: null, todayTokens: null, peakDailyTokens: null,
        currentStreakDays: null, longestStreakDays: null,
      },
      dailyUsage: [],
      error: { code: "COLLECTOR_UNAVAILABLE", message: "Codex usage is temporarily unavailable." },
    }, 503);
  }
};
