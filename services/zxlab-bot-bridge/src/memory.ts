export const memoryNamespaces = ["briefing", "zxlab", "global", "markets"] as const;
export const memoryKinds = ["preference", "fact", "rule", "summary"] as const;

export type MemoryNamespace = typeof memoryNamespaces[number];
export type MemoryKind = typeof memoryKinds[number];

export interface MemoryClientOptions {
  baseUrl: string;
  token: string;
  accessClientId?: string;
  accessClientSecret?: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export interface MemorySearchInput {
  task: string;
  namespaces: MemoryNamespace[];
  query: string;
  limit: number;
  tokenBudget: number;
}

export interface ConfirmedMemoryInput {
  namespace: MemoryNamespace;
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  sourceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function headers(options: MemoryClientOptions): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    "user-agent": "zxlab-bot-bridge/0.2",
    ...(options.accessClientId ? { "CF-Access-Client-Id": options.accessClientId } : {}),
    ...(options.accessClientSecret ? { "CF-Access-Client-Secret": options.accessClientSecret } : {}),
  };
}

async function post(options: MemoryClientOptions, path: string, body: unknown): Promise<unknown> {
  if (!options.token.trim()) throw new Error("ZXLab canonical Memory is not configured on the server-side bridge.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetcher ?? fetch)(new URL(path, options.baseUrl), {
      method: "POST",
      headers: headers(options),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : `ZXLab canonical Memory returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchCanonicalMemory(
  options: MemoryClientOptions,
  input: MemorySearchInput,
): Promise<Record<string, unknown>> {
  const value = await post(options, "/api/memory/retrieve", input);
  if (!isRecord(value) || !Array.isArray(value.memories) ||
    typeof value.summary !== "string" || typeof value.tokenEstimate !== "number") {
    throw new Error("ZXLab canonical Memory returned an invalid retrieval result.");
  }
  return value;
}

export async function saveConfirmedMemory(
  options: MemoryClientOptions,
  input: ConfirmedMemoryInput,
): Promise<Record<string, unknown>> {
  const value = await post(options, "/api/memory/items", {
    namespace: input.namespace,
    kind: input.kind,
    content: input.content,
    importance: input.importance,
    confidence: input.confidence,
    sourceType: "wechat-confirmed",
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  });
  if (!isRecord(value) || !isRecord(value.memory)) {
    throw new Error("ZXLab canonical Memory returned an invalid create result.");
  }
  return value.memory;
}
