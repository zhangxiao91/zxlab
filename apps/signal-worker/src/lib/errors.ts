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
  if (code === "BRIEFING_NOT_FOUND" || code === "ITEM_NOT_FOUND" || code === "MEMORY_CANDIDATE_NOT_FOUND") return 404;
  if (code === "MEMORY_ALREADY_RESOLVED") return 409;
  if (code === "INVALID_REQUEST" || code === "INVALID_MODEL_OUTPUT") return 400;
  return 500;
}
