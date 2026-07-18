import type { GenerateAIInput, GenerateAIResponse, GenerateAIResult } from "./types.ts";

export class AIClientError extends Error {
  readonly response: Extract<GenerateAIResponse, { ok: false }>;
  readonly status: number;

  constructor(
    message: string,
    response: Extract<GenerateAIResponse, { ok: false }>,
    status: number,
  ) {
    super(message);
    this.name = "AIClientError";
    this.response = response;
    this.status = status;
  }
}

export async function generateAI(
  input: GenerateAIInput,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<GenerateAIResult> {
  const response = await (options.fetcher ?? fetch)("/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    signal: options.signal,
  });
  const payload = await response.json() as GenerateAIResponse;
  if (!response.ok || !payload.ok) {
    const failure = payload as Extract<GenerateAIResponse, { ok: false }>;
    throw new AIClientError(failure.error.message, failure, response.status);
  }
  return payload.data;
}
