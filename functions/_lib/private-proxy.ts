import { RiskReviewError, type RiskReviewEnv, verifyCloudflareAccess } from "./risk/review.ts";
import { signActorEnvelope } from "@zxlab/market-agent-schema";

export interface PrivateProxyEnv extends RiskReviewEnv {
  RUNTIME_API_URL?: string;
  ZX_RUNTIME_SERVICE_TOKEN?: string;
  MARKET_AGENT_API_URL?: string;
  MARKET_AGENT_PROXY_TOKEN?: string;
  MARKET_AGENT_SERVICE?: Fetcher;
}

interface PrivateProxyContext {
  request: Request;
  env: PrivateProxyEnv;
}

type PrivateService = "runtime" | "signal" | "market-agent";
interface PrivateProxyDependencies {
  verifyAccess?: typeof verifyCloudflareAccess;
  fetcher?: typeof fetch;
}

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const signalPathAllowed = (path: string) =>
  path === "/api/annotations"
  || path === "/api/memories"
  || path.startsWith("/api/admin/")
  || path.startsWith("/api/memory/")
  || path.startsWith("/api/memory-candidates/");

const marketAgentPathAllowed = (path: string) => path === "/runs" || path === "/today" || path === "/profile" || path === "/watchlist" || path === "/export" || /^\/runs\/[^/]+(?:\/feedback|\/rerun)?$/.test(path);

function target(service: PrivateService, rawPath: string, env: PrivateProxyEnv): URL {
  const path = `/${rawPath.replace(/^\/+/, "")}`;
  if (service === "runtime" && !path.startsWith("/api/v1/private/")) throw new RiskReviewError("PRIVATE_ROUTE_NOT_ALLOWED", "Private route is not allowed.", 404);
  if (service === "signal" && !signalPathAllowed(path)) throw new RiskReviewError("PRIVATE_ROUTE_NOT_ALLOWED", "Private route is not allowed.", 404);
  if (service === "market-agent" && !marketAgentPathAllowed(path)) throw new RiskReviewError("PRIVATE_ROUTE_NOT_ALLOWED", "Private route is not allowed.", 404);
  const base = env.RUNTIME_API_URL?.trim() || "https://runtime-api.zx-dx.xyz";
  if (service === "market-agent") return new URL(`/api/v1/private/market-agent${path}`, env.MARKET_AGENT_API_URL?.trim() || base);
  return new URL(service === "runtime" ? path : `/api/v1/private/signal${path}`, base);
}

export async function proxyPrivateRequest(context: PrivateProxyContext, service: PrivateService, rawPath: string, dependencies: PrivateProxyDependencies = {}): Promise<Response> {
  try {
    const actor = await (dependencies.verifyAccess ?? verifyCloudflareAccess)(context.request, context.env);
    const token = (service === "market-agent" ? context.env.MARKET_AGENT_PROXY_TOKEN : context.env.ZX_RUNTIME_SERVICE_TOKEN)?.trim();
    if (!token) throw new RiskReviewError("PRIVATE_PROXY_UNAVAILABLE", "Private service credentials are unavailable.", 503);

    const upstream = target(service, rawPath, context.env);
    upstream.search = new URL(context.request.url).search;
    const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: context.request.headers.get("accept") ?? "application/json" });
    if (service === "market-agent") {
      const subject = typeof actor.sub === "string" ? actor.sub : "";
      if (!subject) throw new RiskReviewError("ACCESS_IDENTITY_MISSING", "Cloudflare Access identity is incomplete.", 403);
      const email = typeof actor.email === "string" ? actor.email : undefined;
      headers.set("X-ZX-Actor", await signActorEnvelope({ version: 1, subject, ...(email ? { email } : {}), audience: "market-agent", expiresAt: Math.floor(Date.now() / 1000) + 60 }, token));
    }
    const contentType = context.request.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    const method = context.request.method.toUpperCase();
    const fetcher = dependencies.fetcher ?? (service === "market-agent" && context.env.MARKET_AGENT_SERVICE
      ? (input: RequestInfo | URL, init?: RequestInit) => context.env.MARKET_AGENT_SERVICE!.fetch(new Request(input, init))
      : fetch);
    const response = await fetcher(upstream, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
      redirect: "manual",
    });
    const responseHeaders = new Headers(jsonHeaders);
    for (const name of ["content-type", "content-length"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (cause) {
    const error = cause instanceof RiskReviewError ? cause : new RiskReviewError("PRIVATE_PROXY_UNAVAILABLE", "Private service is temporarily unavailable.", 502, { cause });
    return new Response(JSON.stringify({ error: { code: error.code, message: error.safeMessage } }), { status: error.status, headers: jsonHeaders });
  }
}
