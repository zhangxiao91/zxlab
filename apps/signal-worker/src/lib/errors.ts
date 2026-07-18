import type { SignalErrorCode } from "@zxlab/signal-schema";

export class SignalError extends Error {
  constructor(
    readonly code: SignalErrorCode,
    message: string,
    readonly status = 500,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SignalError";
  }
}

export function errorStatus(code: SignalErrorCode): number {
  if (code === "UNAUTHORIZED") return 401;
  if (code === "BRIEFING_NOT_FOUND" || code === "ITEM_NOT_FOUND" || code === "MEMORY_CANDIDATE_NOT_FOUND"
    || code === "SOURCE_NOT_FOUND" || code === "COLLECTION_RUN_NOT_FOUND") return 404;
  if (code === "MEMORY_ALREADY_RESOLVED" || code === "SOURCE_DISABLED") return 409;
  if (code === "INVALID_REQUEST" || code === "INVALID_MODEL_OUTPUT" || code === "NORMALIZATION_FAILED") return 400;
  if (code === "NO_ELIGIBLE_CANDIDATES") return 422;
  if (code === "RATE_LIMITED") return 429;
  if (code === "SOURCE_TIMEOUT") return 504;
  if (code === "SOURCE_FETCH_FAILED" || code === "INVALID_FEED" || code === "INVALID_SOURCE_RESPONSE"
    || code === "PARTIAL_COLLECTION" || code === "MODEL_REQUEST_FAILED") return 502;
  return 500;
}
