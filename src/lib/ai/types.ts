export type AIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AIResponseFormat = { type: "text" } | { type: "json" };

export type GenerateAIInput = {
  task: string;
  messages: AIMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: AIResponseFormat;
};

export type AIUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type GenerateAIResult = {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
  fallbackIndex: number;
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
