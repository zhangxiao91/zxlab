import { SignalValidationError, type SignalErrorResponse } from "@zxlab/signal-schema";
import { SignalError, errorStatus } from "./errors";

const MAX_BODY_BYTES = 96 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new SignalError("INVALID_REQUEST", "Request body is too large", 413);
  try {
    return await request.json();
  } catch (cause) {
    throw new SignalError("INVALID_REQUEST", "Request body must be valid JSON", 400, cause);
  }
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

export function errorResponse(error: unknown, path: string): Response {
  const normalized = error instanceof SignalError
    ? error
    : error instanceof SignalValidationError
      ? new SignalError("INVALID_REQUEST", error.message, 400, error)
      : new SignalError("DATABASE_WRITE_FAILED", "The request could not be completed", 500, error);

  console.error(JSON.stringify({
    event: "signal.request.failed",
    path,
    code: normalized.code,
    errorType: error instanceof Error ? error.name : "Unknown",
  }));
  const body: SignalErrorResponse = { error: { code: normalized.code, message: normalized.message } };
  return json(body, normalized.status || errorStatus(normalized.code));
}

export function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ "vary": "Origin" });
  const origin = request.headers.get("origin");
  const allowed = env.ZX_SIGNAL_ALLOWED_ORIGINS.split(",").map((value) => value.trim());
  if (origin && allowed.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-headers", "content-type, authorization");
    headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  }
  return headers;
}
