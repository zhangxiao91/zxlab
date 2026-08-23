import { SignalError } from "./lib/errors";
import { corsHeaders, errorResponse, json } from "./lib/http";
import { requireWriteAccess } from "./middleware/auth";
import { handleAdmin } from "./routes/admin";
import { handleAnnotations, type AnnotationDependencies } from "./routes/annotations";
import { handleBriefingRead } from "./routes/briefings";
import { handleCollection } from "./routes/collection";
import { handleMemories } from "./routes/memories";
import { handleMemoryApi } from "./memory/api/routes";
import { handleWatches } from "./routes/watches";
import { DailyPipelineRunner } from "./services/daily-pipeline-runner";

const traceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function internalTokenValid(request: Request, env: Env): Promise<boolean> {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = String(env.ZX_RUNTIME_SERVICE_TOKEN ?? "");
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
}

async function runtimeHealth(request: Request, env: Env): Promise<Response> {
  if (!await internalTokenValid(request, env)) throw new SignalError("UNAUTHORIZED", "Runtime service token is required", 401);
  const startedAt = Date.now();
  await env.DB.prepare("SELECT 1 ok").first();
  const [active, proposed, lastWrite, lastConsolidation] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) count FROM memory_items WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)").bind(new Date().toISOString()).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) count FROM memory_consolidation_candidates WHERE status = 'proposed'").first<{ count: number }>(),
    env.DB.prepare("SELECT MAX(updated_at) value FROM memory_items").first<{ value: string | null }>(),
    env.DB.prepare("SELECT MAX(created_at) value FROM memory_consolidation_candidates").first<{ value: string | null }>(),
  ]);
  const generatedAt = new Date().toISOString();
  return json({
    schemaVersion: "1",
    serviceId: "signal",
    status: "operational",
    version: "signal-worker",
    generatedAt,
    checks: [
      { id: "worker", status: "operational" },
      { id: "d1", status: "operational", latencyMs: Date.now() - startedAt, lastSuccessAt: generatedAt },
      { id: "memory", status: "operational", lastSuccessAt: lastWrite?.value ?? generatedAt },
    ],
    public: {
      memory: {
        activeCount: active?.count ?? 0,
        proposedCount: proposed?.count ?? 0,
        lastWriteAt: lastWrite?.value ?? null,
        lastConsolidationAt: lastConsolidation?.value ?? null,
      },
    },
  });
}

function withCors(response: Response, request: Request, env: Env, traceId?: string): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  if (traceId) headers.set("X-ZX-Trace-Id", traceId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isProtected(request: Request, pathname: string): boolean {
  if (pathname.startsWith("/api/memory/")) return true;
  if (pathname.startsWith("/api/admin/")) return true;
  if (pathname === "/api/watches" || pathname.startsWith("/api/watches/")) return true;
  if (request.method === "POST") return pathname.startsWith("/api/admin/") || pathname === "/api/annotations" || pathname.startsWith("/api/memory-candidates/");
  return request.method === "GET" && pathname === "/api/memories";
}

export interface SignalWorkerDependencies {
  annotations?: AnnotationDependencies;
}

export async function handleSignalFetch(
  request: Request,
  env: Env,
  dependencies: SignalWorkerDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const startedAt = Date.now();
  let traceId: string = crypto.randomUUID();
  try {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request, env);
    if (request.method === "GET" && url.pathname === "/health") return withCors(json({ ok: true, service: "zx-signal" }), request, env);
    if (request.method === "GET" && url.pathname === "/internal/runtime/health") return runtimeHealth(request, env);
    const protectedRequest = isProtected(request, url.pathname);
    if (protectedRequest) {
      await requireWriteAccess(request, env, url.pathname);
      if (await internalTokenValid(request, env)) {
        const candidate = request.headers.get("x-zx-trace-id")?.trim() ?? "";
        if (traceIdPattern.test(candidate)) traceId = candidate;
      }
    }
    const response = await handleBriefingRead(url.pathname, env)
      ?? await handleCollection(request, url, env)
      ?? await handleAdmin(request, url.pathname, env)
      ?? await handleAnnotations(request, url.pathname, env, dependencies.annotations)
      ?? await handleMemoryApi(request, url.pathname, env)
      ?? await handleMemories(request, url.pathname, env)
      ?? await handleWatches(request, url.pathname, env);
    if (!response) throw new SignalError("BRIEFING_NOT_FOUND", "Route not found", 404);
    if (protectedRequest) {
      console.log(JSON.stringify({ event: "signal.request.completed", service: "signal", traceId,
        method: request.method.toUpperCase(), pathname: url.pathname, status: response.status,
        durationMs: Date.now() - startedAt }));
    }
    return withCors(response, request, env, protectedRequest ? traceId : undefined);
  } catch (error) {
    return withCors(errorResponse(error, { path: url.pathname, method: request.method.toUpperCase(), traceId, startedAt }), request, env, traceId);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleSignalFetch(request, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (String(env.ZX_SIGNAL_SCHEDULE_ENABLED) !== "true") {
      console.log(JSON.stringify({ event: "signal.schedule.skipped", reason: "disabled", cron: controller.cron }));
      return;
    }
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
      try {
        const result = await new DailyPipelineRunner(env.DB, {}, env).run(controller.scheduledTime);
        const event = result.status === "succeeded" ? "signal.schedule.succeeded"
          : controller.cron === "0 0 * * *" ? "signal.pipeline.sla_breached" : "signal.schedule.failed";
        const log = { event, cron: controller.cron, durationMs: Date.now() - startedAt, runId: result.id,
          stage: result.currentStage, status: result.status, attemptCount: result.attemptCount, errorCode: result.errorCode };
        if (result.status === "succeeded") console.log(JSON.stringify(log));
        else console.error(JSON.stringify(log));
      } catch (cause) {
        console.error(JSON.stringify({ event: "signal.schedule.failed", cron: controller.cron,
          durationMs: Date.now() - startedAt, errorCode: cause instanceof SignalError ? cause.code : "PIPELINE_FAILED" }));
      }
    })());
  },
} satisfies ExportedHandler<Env>;
