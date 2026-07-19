import type { AIStreamEvent, GenerateAIInput, GenerateAIResponse, GenerateAIResult } from "./types.ts";

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

export class AIStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIStreamProtocolError";
  }
}

function streamEvent(value: unknown): AIStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AIStreamProtocolError("The AI stream returned an invalid event.");
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || typeof event.requestId !== "string") throw new AIStreamProtocolError("The AI stream returned an invalid event.");
  if (!new Set(["start", "attempt", "delta", "reset", "done", "error"]).has(event.type)) throw new AIStreamProtocolError("The AI stream returned an unknown event.");
  return value as AIStreamEvent;
}

async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AIStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let terminal = false;

  const parseData = (): AIStreamEvent | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    try { return streamEvent(JSON.parse(data) as unknown); }
    catch (cause) {
      if (cause instanceof AIStreamProtocolError) throw cause;
      throw new AIStreamProtocolError("The AI stream returned invalid JSON.");
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          const event = parseData();
          if (event) {
            if (event.type === "done" || event.type === "error") terminal = true;
            yield event;
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    buffer += decoder.decode();
    const finalLine = buffer.replace(/\r$/, "");
    if (finalLine.startsWith("data:")) dataLines.push(finalLine.slice(5).trimStart());
    const event = parseData();
    if (event) {
      if (event.type === "done" || event.type === "error") terminal = true;
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
  if (!terminal) throw new AIStreamProtocolError("The AI stream ended before a terminal event.");
}

export async function* streamAI(
  input: GenerateAIInput,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; endpoint?: string; headers?: HeadersInit } = {},
): AsyncGenerator<AIStreamEvent> {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!headers.has("Accept")) headers.set("Accept", "text/event-stream");
  const response = await (options.fetcher ?? fetch)(options.endpoint ?? "/api/ai/stream", {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!response.ok) {
    const payload = await response.json() as GenerateAIResponse;
    const failure = payload as Extract<GenerateAIResponse, { ok: false }>;
    throw new AIClientError(failure.error.message, failure, response.status);
  }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    throw new AIStreamProtocolError("The AI endpoint did not return an event stream.");
  }
  yield* parseEventStream(response.body);
}
