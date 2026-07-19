import type { GenerateAIInput, AIUsage } from "../../../../src/lib/ai/types.ts";
import type { ModelCandidate } from "../config.ts";

export interface RequestContext {
  requestId: string;
  timeoutMs: number;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export interface ProviderGenerateResult {
  text: string;
  usage?: AIUsage;
  statusCode?: number;
}

export interface AIProviderAdapter {
  generate(candidate: ModelCandidate, input: GenerateAIInput, context: RequestContext): Promise<ProviderGenerateResult>;
  stream(
    candidate: ModelCandidate,
    input: GenerateAIInput,
    context: RequestContext,
    onDelta: (text: string) => Promise<void>,
  ): Promise<ProviderGenerateResult>;
}
