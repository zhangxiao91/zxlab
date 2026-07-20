export interface RiskMarketProxyEnv {
  RISK_MARKET?: { fetch(request: Request): Promise<Response> };
  RISK_MARKET_API_URL?: string;
}

export interface RiskMarketFunctionContext {
  request: Request;
  env: RiskMarketProxyEnv;
}

const DEFAULT_UPSTREAM = "https://zxlab-risk-market.zhangxiao9118.workers.dev";
const ALLOWED_PATH = /^\/api\/market\/(?:quotes|providers|status|news|announcements|bars\/[^/]+)$/;
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"];

function json(data: unknown, status: number) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function proxyRiskMarket(context: RiskMarketFunctionContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (context.request.method !== "GET") {
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "行情代理仅支持 GET" }, requestId }, 405);
  }

  const incoming = new URL(context.request.url);
  if (!ALLOWED_PATH.test(incoming.pathname)) {
    return json({ error: { code: "INVALID_MARKET_ROUTE", message: "不支持的行情路径" }, requestId }, 404);
  }

  const upstreamBase = context.env.RISK_MARKET_API_URL?.trim() || DEFAULT_UPSTREAM;
  const upstream = new URL(`${incoming.pathname}${incoming.search}`, `${upstreamBase.replace(/\/$/, "")}/`);
  const headers = new Headers({ accept: "application/json" });
  const request = new Request(upstream, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });

  try {
    const response = context.env.RISK_MARKET
      ? await context.env.RISK_MARKET.fetch(new Request(`https://risk-market.internal${incoming.pathname}${incoming.search}`, request))
      : await fetch(request);
    const responseHeaders = new Headers({ "x-risk-market-request-id": requestId });
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("referrer-policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error(JSON.stringify({ event: "risk_market_proxy_failed", requestId, path: incoming.pathname, code: timeout ? "MARKET_GATEWAY_TIMEOUT" : "MARKET_GATEWAY_UNREACHABLE" }));
    return json({ error: { code: timeout ? "MARKET_GATEWAY_TIMEOUT" : "MARKET_GATEWAY_UNREACHABLE", message: timeout ? "行情网关请求超时" : "行情网关当前不可达" }, requestId }, timeout ? 504 : 502);
  }
}
