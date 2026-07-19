export type AIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AIResponseFormat = { type: "text" } | { type: "json" };

export type LLMCallContext = {
  /** A short, stable ZXLab module name. Never put user content in this field. */
  source?: string;
  operation?: string;
  requestId?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type GenerateAIInput = {
  task: string;
  messages: AIMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: AIResponseFormat;
  context?: LLMCallContext;
};

export type AIUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type GenerateAIResult = {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
  fallbackIndex: number;
  attempts?: number;
  latencyMs: number;
  usage?: AIUsage;
};

export type AIErrorCode =
  | "INVALID_INPUT"
  | "MISSING_CONFIGURATION"
  | "UNAUTHORIZED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "MODEL_UNAVAILABLE"
  | "CONTEXT_TOO_LONG"
  | "INVALID_PROVIDER_RESPONSE"
  | "INVALID_STRUCTURED_OUTPUT"
  | "ALL_CANDIDATES_FAILED"
  | "UNKNOWN";

export type GenerateAISuccessResponse = {
  ok: true;
  data: GenerateAIResult;
  requestId: string;
};

export type GenerateAIErrorResponse = {
  ok: false;
  error: {
    code: AIErrorCode;
    message: string;
    attempts?: number;
    debug?: { lastErrorCode?: AIErrorCode };
  };
  requestId: string;
};

export type GenerateAIResponse = GenerateAISuccessResponse | GenerateAIErrorResponse;

export type AIStreamStartEvent = {
  type: "start";
  requestId: string;
};

export type AIStreamAttemptEvent = {
  type: "attempt";
  requestId: string;
  provider: string;
  model: string;
  fallbackIndex: number;
  attempt: number;
};

export type AIStreamDeltaEvent = {
  type: "delta";
  requestId: string;
  text: string;
};

export type AIStreamResetEvent = {
  type: "reset";
  requestId: string;
  reason: "retry" | "fallback";
};

export type AIStreamDoneEvent = {
  type: "done";
  requestId: string;
  data: GenerateAIResult;
};

export type AIStreamErrorEvent = {
  type: "error";
  requestId: string;
  error: GenerateAIErrorResponse["error"];
};

export type AIStreamEvent =
  | AIStreamStartEvent
  | AIStreamAttemptEvent
  | AIStreamDeltaEvent
  | AIStreamResetEvent
  | AIStreamDoneEvent
  | AIStreamErrorEvent;
