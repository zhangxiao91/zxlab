import type { ConfirmedContext, ConfirmedContextRole, MarketAgentCommand } from "@zxlab/market-agent-schema";

const CONTEXT_LIMIT = 12;
const CONTEXT_TOKEN_BUDGET = 1_200;
const ALLOWED_NAMESPACES = ["markets", "global"] as const;
const ROLE_BY_MEMORY = new Map<string, ConfirmedContextRole>([
  ["preference:market-agent-preference", "preference"],
  ["summary:market-agent-watch-reason", "watch_reason"],
  ["summary:market-agent-belief", "belief"],
  ["decision:market-agent-presentation-constraint", "constraint"],
]);

export interface ConfirmedContextResult {
  contexts: ConfirmedContext[];
  limitations: string[];
}

export interface ConfirmedContextReader {
  retrieve(input: {
    profileId: string;
    workflow: MarketAgentCommand["workflow"];
    instrumentIds: string[];
    question?: string;
  }): Promise<ConfirmedContextResult>;
}

export class SignalMemoryAdapter implements ConfirmedContextReader {
  private readonly options: { service?: Fetcher; baseUrl?: string; token?: string; fetcher?: typeof fetch; timeoutMs?: number };

  constructor(options: { service?: Fetcher; baseUrl?: string; token?: string; fetcher?: typeof fetch; timeoutMs?: number }) {
    this.options = options;
  }

  async retrieve(input: Parameters<ConfirmedContextReader["retrieve"]>[0]): Promise<ConfirmedContextResult> {
    if (!this.options.service && !this.options.baseUrl && !this.options.fetcher) {
      return { contexts: [], limitations: ["Signal Memory service is not configured; confirmed context was not used."] };
    }
    const url = new URL("/api/memory/retrieve", this.options.baseUrl?.trim() || "https://signal.internal");
    const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    const body = JSON.stringify({
      task: `market-agent:${input.workflow}`,
      namespaces: [...ALLOWED_NAMESPACES],
      query: [input.workflow, ...input.instrumentIds, input.question?.trim()].filter(Boolean).join(" ").slice(0, 8_000),
      limit: CONTEXT_LIMIT,
      tokenBudget: CONTEXT_TOKEN_BUDGET,
    });
    const timeoutMs = Math.min(15_000, Math.max(1, this.options.timeoutMs ?? 8_000));
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const request = new Request(url, { method: "POST", headers, body, signal });
      const response = this.options.service
        ? await this.options.service.fetch(request)
        : await (this.options.fetcher ?? fetch)(request);
      if (!response.ok) return { contexts: [], limitations: [`Signal Memory retrieve failed with HTTP ${response.status}; confirmed context was not used.`] };
      const payload = await response.json() as { memories?: unknown };
      return this.project(payload.memories);
    } catch (cause) {
      if (signal.aborted) return { contexts: [], limitations: ["Signal Memory retrieve timed out; confirmed context was not used."] };
      return { contexts: [], limitations: ["Signal Memory is unavailable; confirmed context was not used."] };
    }
  }

  private async project(value: unknown): Promise<ConfirmedContextResult> {
    if (!Array.isArray(value)) return { contexts: [], limitations: ["Signal Memory returned an invalid projection; confirmed context was not used."] };
    const contexts: ConfirmedContext[] = [];
    const limitations: string[] = [];
    for (const item of value) {
      const projected = await projectMemory(item);
      if (projected.kind === "context") contexts.push(projected.context);
      else if (projected.kind === "invalid") limitations.push(projected.reason);
    }
    return { contexts, limitations: [...new Set(limitations)].slice(0, 8) };
  }
}

async function projectMemory(value: unknown): Promise<{ kind: "context"; context: ConfirmedContext } | { kind: "ignored" } | { kind: "invalid"; reason: string }> {
  const item = record(value);
  if (!item) return { kind: "ignored" };
  const namespace = item.namespace;
  if (!ALLOWED_NAMESPACES.includes(namespace as typeof ALLOWED_NAMESPACES[number])) return { kind: "ignored" };
  const role = ROLE_BY_MEMORY.get(`${item.kind}:${item.sourceType}`);
  if (!role) return { kind: "ignored" };
  if (item.status !== "active") return { kind: "ignored" };
  if (typeof item.id !== "string" || typeof item.content !== "string" || !item.content.trim() || item.content.length > 8_000) {
    return { kind: "invalid", reason: "Signal Memory returned an invalid confirmed context item; it was not used." };
  }
  if (typeof item.updatedAt !== "string" || typeof item.revisionHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.revisionHash)) {
    return { kind: "invalid", reason: "Signal Memory returned a context without a valid canonical revision hash; it was not used." };
  }
  const expectedHash = await canonicalMemoryRevisionHash(item);
  if (item.revisionHash !== expectedHash) return { kind: "invalid", reason: "Signal Memory canonical revision hash did not verify; context was not used." };
  return {
    kind: "context",
    context: {
      memoryId: item.id,
      role,
      revisionHash: item.revisionHash,
      namespace: namespace as "global" | "markets",
      kind: item.kind as ConfirmedContext["kind"],
      sourceType: item.sourceType as string,
      content: item.content.trim(),
      updatedAt: item.updatedAt,
      ...(typeof item.expiresAt === "string" ? { expiresAt: item.expiresAt } : {}),
    },
  };
}

export async function canonicalMemoryRevisionHash(item: Record<string, unknown>): Promise<`sha256:${string}`> {
  const canonical = JSON.stringify({
    id: item.id,
    namespace: item.namespace,
    kind: item.kind,
    content: item.content,
    importance: item.importance,
    confidence: item.confidence,
    sourceType: item.sourceType,
    sourceId: item.sourceId ?? null,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt ?? null,
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
