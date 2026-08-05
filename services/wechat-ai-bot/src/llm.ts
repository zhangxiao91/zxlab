import fs from "node:fs";
import OpenAI from "openai";
import type { ConversationMessage } from "./store.js";
import { errorMessage, logger } from "./logger.js";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful, concise private AI assistant.";

export interface LlmOptions {
  deepseekApiKey: string;
  kimiApiKey?: string;
  systemPromptFile: string;
  timeoutMs: number;
  maxRetries: number;
  createClient?: (options: { apiKey: string; baseURL: string; timeout: number }) => OpenAI;
}

function readSystemPrompt(filePath: string): string {
  try {
    const prompt = fs.readFileSync(filePath, "utf8").trim();
    if (prompt) return prompt;
    logger.warn("system_prompt_empty", { file: filePath });
  } catch (error) {
    logger.warn("system_prompt_unavailable", { file: filePath, error: errorMessage(error) });
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LlmClient {
  private readonly candidates: Array<{ name: "DeepSeek V4 Flash" | "Kimi K3"; client: OpenAI; model: string }>;
  private readonly systemPrompt: string;

  constructor(private readonly options: LlmOptions) {
    const createClient = options.createClient ?? ((clientOptions) => new OpenAI({ ...clientOptions, maxRetries: 0 }));
    this.candidates = [
      {
        name: "DeepSeek V4 Flash",
        client: createClient({ apiKey: options.deepseekApiKey, baseURL: "https://api.deepseek.com", timeout: options.timeoutMs }),
        model: "deepseek-v4-flash",
      },
      ...(options.kimiApiKey ? [{
        name: "Kimi K3" as const,
        client: createClient({ apiKey: options.kimiApiKey, baseURL: "https://api.moonshot.ai/v1", timeout: options.timeoutMs }),
        model: "kimi-k3",
      }] : []),
    ];
    this.systemPrompt = readSystemPrompt(options.systemPromptFile);
  }

  async complete(messages: ConversationMessage[]): Promise<string> {
    let lastError: unknown;
    for (const candidate of this.candidates) {
      try {
        return await this.completeWithCandidate(candidate, messages);
      } catch (error) {
        lastError = error;
        if (!retryable(error) || candidate === this.candidates.at(-1)) throw error;
        logger.warn("llm_provider_fallback", {
          from: candidate.name,
          to: this.candidates[this.candidates.indexOf(candidate) + 1]?.name,
          error: errorMessage(error),
        });
      }
    }
    throw lastError ?? new Error("No LLM candidate is configured");
  }

  private async completeWithCandidate(
    candidate: { name: string; client: OpenAI; model: string },
    messages: ConversationMessage[],
  ): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        logger.info("llm_request_started", {
          provider: candidate.name,
          model: candidate.model,
          messageCount: messages.length,
          attempt: attempt + 1,
        });
        const response = await candidate.client.chat.completions.create({
          model: candidate.model,
          messages: [
            { role: "system", content: this.systemPrompt },
            ...messages.map((message) => ({ role: message.role, content: message.content })),
          ],
        });
        const content = response.choices[0]?.message.content?.trim();
        if (!content) throw new Error("Model returned an empty response");
        logger.info("llm_request_completed", { provider: candidate.name, model: candidate.model, outputChars: Array.from(content).length });
        return content;
      } catch (error) {
        if (attempt >= this.options.maxRetries || !retryable(error)) throw error;
        const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
        logger.warn("llm_request_retry", {
          provider: candidate.name,
          model: candidate.model,
          attempt: attempt + 1,
          delayMs,
          error: errorMessage(error),
        });
        await wait(delayMs);
      }
    }
  }
}
