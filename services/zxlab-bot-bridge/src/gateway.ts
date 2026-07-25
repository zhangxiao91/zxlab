export type GatewayResponseFormat = "text" | "json";

export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayTaskInput {
  task: string;
  messages: GatewayMessage[];
  responseFormat: { type: GatewayResponseFormat };
  maxOutputTokens?: number;
  temperature?: number;
  context?: {
    source: string;
    operation: string;
    metadata?: Record<string, string | number | boolean>;
  };
}

export interface GatewayResult {
  text: string;
  json?: unknown;
  provider: string;
  model: string;
  fallbackIndex: number;
  latencyMs: number;
  usage?: Record<string, number>;
  requestId?: string;
  transport: "stream" | "generate-fallback";
}

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

class GatewayCallError extends Error {
  constructor(message: string, readonly fallbackable: boolean) {
    super(message);
    this.name = "GatewayCallError";
  }
}

function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseResult(value: unknown): Omit<GatewayResult, "transport"> {
  if (!isRecord(value) || typeof value.text !== "string" || typeof value.provider !== "string" ||
    typeof value.model !== "string" || typeof value.fallbackIndex !== "number" ||
    typeof value.latencyMs !== "number") {
    throw new GatewayCallError("ZXLab AI Gateway returned an invalid result.", false);
  }
  const usage = isRecord(value.usage)
    ? Object.fromEntries(Object.entries(value.usage).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
    : undefined;
  return {
    text: value.text,
    ...(value.json === undefined ? {} : { json: value.json }),
    provider: value.provider,
    model: value.model,
    fallbackIndex: value.fallbackIndex,
    latencyMs: value.latencyMs,
    ...(usage && Object.keys(usage).length ? { usage } : {}),
  };
}

async function request(
  options: GatewayClientOptions,
  path: string,
  input: GatewayTaskInput,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await (options.fetcher ?? fetch)(endpoint(options.baseUrl, path), {
      method: "POST",
      headers: {
        accept: path.endsWith("/stream") ? "text/event-stream" : "application/json",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "user-agent": "zxlab-bot-bridge/0.2",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function stream(options: GatewayClientOptions, input: GatewayTaskInput): Promise<GatewayResult> {
  let response: Response;
  try {
    response = await request(options, "/api/ai/stream", input);
  } catch (error) {
    throw new GatewayCallError(error instanceof Error ? error.message : "ZXLab AI Gateway stream transport failed.", true);
  }
  if (!response.ok) {
    const fallbackable = [404, 405, 406, 415, 501].includes(response.status);
    throw new GatewayCallError(`ZXLab AI Gateway stream returned HTTP ${response.status}.`, fallbackable);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new GatewayCallError("ZXLab AI Gateway stream protocol was unavailable.", true);
  }
  const body = await response.text();
  let terminal: Record<string, unknown> | undefined;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      throw new GatewayCallError("ZXLab AI Gateway returned malformed SSE data.", true);
    }
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      const detail = isRecord(event.error) && typeof event.error.message === "string"
        ? event.error.message
        : "ZXLab AI Gateway model request failed.";
      throw new GatewayCallError(detail, false);
    }
    if (event.type === "done") terminal = event;
  }
  if (!terminal) throw new GatewayCallError("ZXLab AI Gateway stream ended without a terminal result.", true);
  return {
    ...parseResult(terminal.data),
    requestId: typeof terminal.requestId === "string" ? terminal.requestId : undefined,
    transport: "stream",
  };
}

async function generate(options: GatewayClientOptions, input: GatewayTaskInput): Promise<GatewayResult> {
  const response = await request(options, "/api/ai/generate", input);
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(value) || value.ok !== true) {
    const detail = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
      ? value.error.message
      : `ZXLab AI Gateway generate returned HTTP ${response.status}.`;
    throw new GatewayCallError(detail, false);
  }
  return {
    ...parseResult(value.data),
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    transport: "generate-fallback",
  };
}

export async function runGatewayTask(options: GatewayClientOptions, input: GatewayTaskInput): Promise<GatewayResult> {
  if (!options.token.trim()) throw new Error("ZXLab AI Gateway is not configured on the server-side bridge.");
  try {
    return await stream(options, input);
  } catch (error) {
    if (!(error instanceof GatewayCallError) || !error.fallbackable) throw error;
    return generate(options, input);
  }
}
