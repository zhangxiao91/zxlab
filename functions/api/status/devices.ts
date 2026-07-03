import { getPublicTailscaleDevices, parsePublicDeviceMap } from "../../_lib/tailscale";
import type { TailscaleEnv } from "../../_lib/tailscale";

interface FunctionContext {
  request: Request;
  env: TailscaleEnv;
  waitUntil(promise: Promise<unknown>): void;
}

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(data: unknown, status = 200, responseHeaders = headers) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export const onRequestGet = async (context: FunctionContext) => {
  try {
    const definitions = parsePublicDeviceMap(context.env.TAILSCALE_PUBLIC_DEVICES);
    if (Object.keys(definitions).length === 0) {
      return json(
        { error: "status_unavailable", message: "No public devices are configured." },
        503,
        { ...headers, "Cache-Control": "no-store" },
      );
    }

    const cache = (caches as CacheStorage & { default: Cache }).default;
    const url = new URL(context.request.url);
    const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const devices = await getPublicTailscaleDevices(context.env);
    const response = json(devices);
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch {
    return json(
      { error: "status_unavailable", message: "Live device status is temporarily unavailable." },
      503,
      { ...headers, "Cache-Control": "no-store" },
    );
  }
};
