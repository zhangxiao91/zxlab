import { RiskReviewError, verifyCloudflareAccess } from "./risk/review.ts";
import { actorRequestBodyHash, createActorRequestBinding, signActorEnvelope } from "@zxlab/market-agent-schema";
import { requireActorScope, resolveAccessActor, type AccessActorEnv } from "./access/actor.ts";

export interface PrivateProxyEnv extends AccessActorEnv {
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
export interface PrivateProxyDependencies {
  verifyAccess?: typeof verifyCloudflareAccess;
  fetcher?: typeof fetch;
  createTraceId?: () => string;
}

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const watchRequestAllowed = (path: string, method: string) =>
  (path === "/api/watches" && (method === "GET" || method === "POST"))
  || (/^\/api\/watches\/[^/]+\/resolve$/.test(path) && method === "POST");

const signalPathAllowed = (path: string, method: string) =>
  path === "/api/annotations"
  || path === "/api/memories"
  || watchRequestAllowed(path, method)
  || path.startsWith("/api/admin/")
  || path.startsWith("/api/memory/")
  || path.startsWith("/api/memory-candidates/");

const marketAgentPathAllowed = (path: string, method: string) => {
  if (path === "/ask") return method === "POST";
  if (path === "/runs" || path === "/watchlist" || path === "/portfolio-snapshot") return method === "GET" || method === "POST";
  if (["/today", "/profile", "/quality", "/export"].includes(path)) return method === "GET";
  if (["/portfolio-snapshot/stop", "/portfolio-snapshot/purge"].includes(path)) return method === "POST";
  if (/^\/runs\/[^/]+$/.test(path)) return method === "GET" || method === "DELETE";
  if (/^\/runs\/[^/]+\/(?:feedback|rerun|retry|cancel)$/.test(path)) return method === "POST";
  return /^\/runs\/[^/]+\/(?:evidence|stream|trace|tool-trace)$/.test(path) && method === "GET";
};

function target(service: PrivateService, rawPath: string, method: string, env: PrivateProxyEnv): URL {
  const path = `/${rawPath.replace(/^\/+/, "")}`;
  if (service === "runtime" && !path.startsWith("/api/v1/private/")) throw new RiskReviewError("PRIVATE_ROUTE_NOT_ALLOWED", "Private route is not allowed.", 404);
  if (service === "signal" && !signalPathAllowed(path, method)) throw new RiskReviewError("PRIVATE_ROUTE_NOT_ALLOWED", "Private route is not allowed.", 404);
  if (service === "market-agent" && !marketAgentPathAllowed(path, method)) throw new RiskReviewError("PRIVATE_ROUTE_NOT_ALLOWED", "Private route is not allowed.", 404);
  const base = env.RUNTIME_API_URL?.trim() || "https://runtime-api.zx-dx.xyz";
  if (service === "market-agent") return new URL(`/api/v1/private/market-agent${path}`, env.MARKET_AGENT_API_URL?.trim() || base);
  return new URL(service === "runtime" ? path : `/api/v1/private/signal${path}`, base);
}

export async function proxyPrivateRequest(context: PrivateProxyContext, service: PrivateService, rawPath: string, dependencies: PrivateProxyDependencies = {}): Promise<Response> {
  const startedAt = Date.now();
  const traceId = (dependencies.createTraceId ?? (() => crypto.randomUUID()))();
  const method = context.request.method.toUpperCase();
  const pathname = `/${rawPath.replace(/^\/+/, "")}`;
  try {
    const actor = await resolveAccessActor(context.request, context.env, { verifyAccess: dependencies.verifyAccess });
    const token = (service === "market-agent" ? context.env.MARKET_AGENT_PROXY_TOKEN : context.env.ZX_RUNTIME_SERVICE_TOKEN)?.trim();
    if (!token) throw new RiskReviewError("PRIVATE_PROXY_UNAVAILABLE", "Private service credentials are unavailable.", 503);

    const upstream = target(service, rawPath, method, context.env);
    upstream.search = new URL(context.request.url).search;
    requireActorScope(actor, privateScope(service, method));
    const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: context.request.headers.get("accept") ?? "application/json" });
    headers.set("X-ZX-Trace-Id", traceId);
    if (service === "market-agent") {
      const issuedAt = Math.floor(Date.now() / 1_000);
      headers.set("X-ZX-Actor", await signActorEnvelope({
        version: 2,
        kind: actor.kind,
        subject: actor.subject,
        ownerSubject: actor.ownerSubject,
        actorId: actor.actorId,
        scopes: actor.scopes,
        audience: "market-agent",
        issuedAt,
        expiresAt: issuedAt + 60,
        jti: crypto.randomUUID(),
        request: createActorRequestBinding(method, `${upstream.pathname}${upstream.search}`, await actorRequestBodyHash(context.request)),
      }, token));
    }
    const contentType = context.request.headers.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    const idempotencyKey = context.request.headers.get("idempotency-key");
    if (service === "signal" && idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    const fetcher = dependencies.fetcher ?? (service === "market-agent" && context.env.MARKET_AGENT_SERVICE
      ? (input: RequestInfo | URL, init?: RequestInit) => context.env.MARKET_AGENT_SERVICE!.fetch(new Request(input, init))
      : fetch);
    const response = await fetcher(upstream, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : context.request.body,
      redirect: "manual",
    });
    if (response.status === 401) {
      console.error(JSON.stringify({ event: "private_proxy.upstream_auth_failed", service, traceId, method, pathname: upstream.pathname,
        status: response.status, durationMs: Date.now() - startedAt, errorCode: "PRIVATE_UPSTREAM_AUTH_FAILED" }));
      throw new RiskReviewError("PRIVATE_UPSTREAM_AUTH_FAILED", "Private service authentication failed.", 502);
    }
    const responseHeaders = new Headers(jsonHeaders);
    for (const name of ["content-type", "content-length"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("X-ZX-Trace-Id", traceId);
    console.log(JSON.stringify({ event: "private_proxy.completed", service, traceId, method, pathname: upstream.pathname,
      status: response.status, durationMs: Date.now() - startedAt }));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (cause) {
    const error = cause instanceof RiskReviewError ? cause : new RiskReviewError("PRIVATE_PROXY_UNAVAILABLE", "Private service is temporarily unavailable.", 502, { cause });
    console.error(JSON.stringify({ event: "private_proxy.failed", service, traceId, method, pathname,
      status: error.status, durationMs: Date.now() - startedAt, errorCode: error.code }));
    return new Response(JSON.stringify({ error: { code: error.code, message: error.safeMessage } }), {
      status: error.status,
      headers: { ...jsonHeaders, "X-ZX-Trace-Id": traceId },
    });
  }
}

function privateScope(service: PrivateService, method: string): string {
  const action = method === "GET" || method === "HEAD" ? "read" : "write";
  return `${service}:${action}`;
}
