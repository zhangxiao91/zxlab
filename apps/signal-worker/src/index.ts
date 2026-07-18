import { SignalError } from "./lib/errors";
import { corsHeaders, errorResponse, json } from "./lib/http";
import { requireWriteAccess } from "./middleware/auth";
import { handleAdmin } from "./routes/admin";
import { handleAnnotations } from "./routes/annotations";
import { handleBriefingRead } from "./routes/briefings";
import { handleCollection } from "./routes/collection";
import { handleMemories } from "./routes/memories";

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  corsHeaders(request, env).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isProtected(request: Request, pathname: string): boolean {
  if (pathname.startsWith("/api/admin/")) return true;
  if (request.method === "POST") return pathname.startsWith("/api/admin/") || pathname === "/api/annotations" || pathname.startsWith("/api/memory-candidates/");
  return request.method === "GET" && pathname === "/api/memories";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request, env);
      if (request.method === "GET" && url.pathname === "/health") return withCors(json({ ok: true, service: "zx-signal" }), request, env);
      if (isProtected(request, url.pathname)) await requireWriteAccess(request, env);
      const response = await handleBriefingRead(url.pathname, env)
        ?? await handleCollection(request, url, env)
        ?? await handleAdmin(request, url.pathname, env)
        ?? await handleAnnotations(request, url.pathname, env)
        ?? await handleMemories(request, url.pathname, env);
      if (!response) throw new SignalError("BRIEFING_NOT_FOUND", "Route not found", 404);
      return withCors(response, request, env);
    } catch (error) {
      return withCors(errorResponse(error, url.pathname), request, env);
    }
  },
} satisfies ExportedHandler<Env>;
