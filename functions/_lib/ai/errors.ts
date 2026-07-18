import type { AIErrorCode } from "../../../src/lib/ai/types.ts";

const SAFE_MESSAGES: Record<AIErrorCode, string> = {
  INVALID_INPUT: "The AI request is invalid.",
  MISSING_CONFIGURATION: "The AI service is not configured.",
  UNAUTHORIZED: "This AI request is not authorized.",
  TIMEOUT: "The AI request timed out.",
  NETWORK_ERROR: "The AI provider could not be reached.",
  RATE_LIMITED: "The AI service is temporarily rate limited.",
  QUOTA_EXCEEDED: "The AI service quota is unavailable.",
  MODEL_UNAVAILABLE: "The requested AI capacity is temporarily unavailable.",
  CONTEXT_TOO_LONG: "The AI request is too long.",
  INVALID_PROVIDER_RESPONSE: "The AI provider returned an invalid response.",
  INVALID_STRUCTURED_OUTPUT: "The AI provider did not return valid structured data.",
  ALL_CANDIDATES_FAILED: "AI service is temporarily unavailable.",
  UNKNOWN: "The AI request failed unexpectedly.",
};

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly safeMessage: string;

  constructor(
    code: AIErrorCode,
    options: {
      cause?: unknown;
      statusCode?: number;
      retryable?: boolean;
      fallbackAllowed?: boolean;
      attempts?: number;
      safeMessage?: string;
    } = {},
  ) {
    super(options.safeMessage ?? SAFE_MESSAGES[code], { cause: options.cause });
    this.name = "AIError";
    this.code = code;
    this.safeMessage = options.safeMessage ?? SAFE_MESSAGES[code];
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.fallbackAllowed = options.fallbackAllowed ?? false;
    this.attempts = options.attempts;
  }

  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly fallbackAllowed: boolean;
  readonly attempts?: number;
}

export function asAIError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AIError("TIMEOUT", { cause: error, fallbackAllowed: true });
  }
  if (error instanceof TypeError) {
    return new AIError("NETWORK_ERROR", { cause: error, retryable: true, fallbackAllowed: true });
  }
  return new AIError("UNKNOWN", { cause: error });
}

export function httpStatusForAIError(error: AIError): number {
  if (error.code === "INVALID_INPUT" || error.code === "CONTEXT_TOO_LONG") return 400;
  if (error.code === "UNAUTHORIZED") return 401;
  if (error.code === "RATE_LIMITED") return 429;
  if (error.code === "MISSING_CONFIGURATION") return 503;
  if (error.code === "TIMEOUT") return 504;
  return 502;
}
