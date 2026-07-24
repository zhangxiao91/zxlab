import fs from "node:fs";
import OpenAI from "openai";
import type { ConversationMessage } from "./store.js";
import { errorMessage, logger } from "./logger.js";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful, concise private AI assistant.";

export interface LlmOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  systemPromptFile: string;
  timeoutMs: number;
  maxRetries: number;
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
  private readonly client: OpenAI;
  private readonly systemPrompt: string;

  constructor(private readonly options: LlmOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      timeout: options.timeoutMs,
      maxRetries: 0,
    });
    this.systemPrompt = readSystemPrompt(options.systemPromptFile);
  }

  async complete(messages: ConversationMessage[]): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        logger.info("llm_request_started", {
          model: this.options.model,
          messageCount: messages.length,
          attempt: attempt + 1,
        });
        const response = await this.client.chat.completions.create({
          model: this.options.model,
          messages: [
            { role: "system", content: this.systemPrompt },
            ...messages.map((message) => ({ role: message.role, content: message.content })),
          ],
        });
        const content = response.choices[0]?.message.content?.trim();
        if (!content) throw new Error("Model returned an empty response");
        logger.info("llm_request_completed", { model: this.options.model, outputChars: Array.from(content).length });
        return content;
      } catch (error) {
        if (attempt >= this.options.maxRetries || !retryable(error)) throw error;
        const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
        logger.warn("llm_request_retry", {
          model: this.options.model,
          attempt: attempt + 1,
          delayMs,
          error: errorMessage(error),
        });
        await wait(delayMs);
      }
    }
  }
}
