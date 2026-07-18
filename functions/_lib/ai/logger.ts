import type { AIErrorCode, AIUsage } from "../../../src/lib/ai/types.ts";

export type AIAttemptLog = {
  event: "ai.gateway.attempt";
  requestId: string;
  task: string;
  candidateId: string;
  attempt: number;
  durationMs: number;
  success: boolean;
  statusCode?: number;
  normalizedErrorCode?: AIErrorCode;
};

export type AIRequestLog = {
  event: "ai.gateway.request";
  requestId: string;
  task: string;
  success: boolean;
  selectedCandidate?: string;
  selectedProvider?: string;
  selectedModel?: string;
  fallbackIndex?: number;
  attempts: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: AIErrorCode;
  messageCount: number;
  inputChars: number;
};

export interface AILogger {
  write(entry: AIAttemptLog | AIRequestLog): void;
}

export const consoleAILogger: AILogger = {
  write(entry) { console.log(JSON.stringify(entry)); },
};

export function usageFields(value?: AIUsage): Pick<AIRequestLog, "inputTokens" | "outputTokens"> {
  return value ? { inputTokens: value.inputTokens, outputTokens: value.outputTokens } : {};
}
