import { OpenAICompatibleAdapter } from "./openai-compatible.ts";

// DeepSeek currently uses the same Chat Completions wire format. Keeping a
// named adapter boundary allows provider-specific behavior without touching callers.
export class DeepSeekCompatibleAdapter extends OpenAICompatibleAdapter {}
