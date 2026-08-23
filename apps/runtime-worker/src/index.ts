import { RuntimeRepository } from "./repository";
import { runAllProbes } from "./probes";
import { publicSnapshot } from "./status";
import { requireAccess } from "./auth";

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const json = (value: unknown, status = 200, extra: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...extra } });
const traceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trustedTraceId(request: Request): string {
  const candidate = request.headers.get("x-zx-trace-id")?.trim() ?? "";
  return traceIdPattern.test(candidate) ? candidate : crypto.randomUUID();
}

function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowed = env.RUNTIME_ALLOWED_ORIGINS.split(",").map((item) => item.trim());
  const matches = allowed.includes(origin) || allowed.some((item) => item.includes("*") && origin.endsWith(item.slice(item.indexOf("*") + 1)));
  return matches ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {};
}

async function proxyMemory(request: Request, env: Env, pathname: string) {
  const suffix = pathname.slice("/api/v1/private/memory".length);
  const target = `https://signal.internal/api/memory${suffix}`;
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${env.ZX_RUNTIME_SERVICE_TOKEN}`, "content-type": request.headers.get("content-type") ?? "application/json" });
  for (const name of ["cf-access-jwt-assertion", "cf-access-authenticated-user-email"]) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  const response = await env.SIGNAL.fetch(target, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body });
  const responseHeaders = new Headers(response.headers);
  Object.entries(cors(request, env)).forEach(([key, value]) => responseHeaders.set(key, value));
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

function signalPathAllowed(path: string, method: string): boolean {
  const watchAllowed = (path === "/api/watches" && (method === "GET" || method === "POST"))
    || (/^\/api\/watches\/[^/]+\/resolve$/.test(path) && method === "POST");
  return path === "/api/annotations"
    || path === "/api/memories"
    || watchAllowed
    || path.startsWith("/api/admin/")
    || path.startsWith("/api/memory/")
    || path.startsWith("/api/memory-candidates/");
}

async function proxySignal(request: Request, env: Env, pathname: string, traceId: string) {
  const startedAt = Date.now();
  const suffix = pathname.slice("/api/v1/private/signal".length);
  if (!signalPathAllowed(suffix, request.method.toUpperCase())) {
    return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404, { "x-zx-trace-id": traceId });
  }
  const target = new URL(`https://signal.internal${suffix}`);
  target.search = new URL(request.url).search;
  const headers = new Headers({ Accept: request.headers.get("accept") ?? "application/json", Authorization: `Bearer ${env.ZX_RUNTIME_SERVICE_TOKEN}` });
  headers.set("X-ZX-Trace-Id", traceId);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  const response = await env.SIGNAL.fetch(target, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("X-ZX-Trace-Id", traceId);
  console.log(JSON.stringify({ event: "runtime.signal_proxy.completed", service: "runtime", traceId,
    method: request.method.toUpperCase(), pathname: target.pathname, status: response.status, durationMs: Date.now() - startedAt }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}

async function probe(env: Env, trigger: string) {
  const results = await runAllProbes(env);
  return new RuntimeRepository(env.DB).record(results, trigger);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const repository = new RuntimeRepository(env.DB);
    const startedAt = Date.now();
    let traceId: string = crypto.randomUUID();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors(request, env), "access-control-allow-methods": "GET, POST, PATCH, OPTIONS", "access-control-allow-headers": "Content-Type" } });
    try {
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "zx-runtime" });
      if (request.method === "GET" && url.pathname === "/api/v1/public/status") {
        if ((await repository.latestRows()).length === 0) await probe(env, "cold-start");
        return json(await publicSnapshot(repository), 200, { ...cors(request, env), "cache-control": "public, max-age=15, s-maxage=30" });
      }
      if (url.pathname.startsWith("/api/v1/private/")) {
        await requireAccess(request, env);
        traceId = trustedTraceId(request);
      }
      if (url.pathname.startsWith("/api/v1/private/signal/")) return proxySignal(request, env, url.pathname, traceId);
      if (url.pathname.startsWith("/api/v1/private/memory")) return proxyMemory(request, env, url.pathname);
      const privateCors = cors(request, env);
      if (request.method === "GET" && url.pathname === "/api/v1/private/overview") return json({ snapshot: await publicSnapshot(repository), services: await repository.services(), incidents: await repository.incidents() }, 200, privateCors);
      if (request.method === "GET" && url.pathname === "/api/v1/private/services") return json({ services: await repository.services() }, 200, privateCors);
      if (request.method === "GET" && url.pathname === "/api/v1/private/incidents") return json({ incidents: await repository.incidents() }, 200, privateCors);
      if (request.method === "POST" && url.pathname === "/api/v1/private/probes/run") return json({ runId: await probe(env, "manual") }, 202, privateCors);
      return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404);
    } catch (error) {
      if (error instanceof Response) {
        const headers = new Headers(error.headers);
        Object.entries(cors(request, env)).forEach(([key, value]) => headers.set(key, value));
        headers.set("X-ZX-Trace-Id", traceId);
        return new Response(error.body, { status: error.status, statusText: error.statusText, headers });
      }
      console.error(JSON.stringify({ event: "runtime.request.failed", service: "runtime", traceId,
        method: request.method.toUpperCase(), pathname: url.pathname, status: 503,
        durationMs: Date.now() - startedAt, errorCode: "RUNTIME_UNAVAILABLE" }));
      return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "Runtime control plane is temporarily unavailable." } }, 503,
        { "x-zx-trace-id": traceId });
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const repository = new RuntimeRepository(env.DB);
    if (controller.cron === "17 3 * * *") {
      const now = Date.now();
      ctx.waitUntil(repository.purge(new Date(now - 30 * 86_400_000).toISOString(), new Date(now - 180 * 86_400_000).toISOString()));
      return;
    }
    ctx.waitUntil(probe(env, "scheduled"));
  },
} satisfies ExportedHandler<Env>;
