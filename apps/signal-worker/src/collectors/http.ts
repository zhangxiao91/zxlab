import type { SignalErrorCode } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";

export async function fetchSource(
  fetcher: typeof fetch,
  url: string,
  options: RequestInit & { timeoutMs?: number; expectedTypes?: string[] } = {},
): Promise<Response> {
  const { timeoutMs = 12_000, expectedTypes, ...init } = options;
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const timeout = cause instanceof DOMException && cause.name === "TimeoutError";
    const code: SignalErrorCode = timeout ? "SOURCE_TIMEOUT" : "SOURCE_FETCH_FAILED";
    throw new SignalError(code, timeout ? "Source request timed out" : "Source request failed", timeout ? 504 : 502, cause);
  }
  if (response.status === 429) throw new SignalError("RATE_LIMITED", "Source rate limit exceeded", 429);
  if (!response.ok) throw new SignalError("SOURCE_FETCH_FAILED", `Source returned HTTP ${response.status}`, 502);
  if (expectedTypes?.length) {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!expectedTypes.some((type) => contentType.includes(type))) {
      throw new SignalError("INVALID_SOURCE_RESPONSE", `Unexpected source content type: ${contentType || "missing"}`, 502);
    }
  }
  return response;
}
