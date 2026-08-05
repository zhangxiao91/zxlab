import assert from "node:assert/strict";
import test from "node:test";
import { streamAI as streamAIClient } from "../src/lib/ai/client.ts";
import type { AIStreamEvent, GenerateAIInput } from "../src/lib/ai/types.ts";
import { getDefaultModelChain, type ModelCandidate } from "../functions/_lib/ai/config.ts";
import { AIError } from "../functions/_lib/ai/errors.ts";
import type { AILogger } from "../functions/_lib/ai/logger.ts";
import { OpenAICompatibleAdapter } from "../functions/_lib/ai/providers/openai-compatible.ts";
import type { AIProviderAdapter, ProviderGenerateResult } from "../functions/_lib/ai/providers/types.ts";
import { generateAI, streamAI } from "../functions/_lib/ai/router.ts";
import { validateGenerateAIInput } from "../functions/_lib/ai/validation.ts";
import { estimateLLMCost, normalizeUsage, type LLMUsageDatabase } from "../functions/_lib/ai/telemetry.ts";
import { resolveTaskPolicy } from "../functions/_lib/ai/task-policies.ts";

const candidates: ModelCandidate[] = [
  { id: "deepseek-v4-flash-official", tier: "deepseek-flash", provider: "deepseek", providerInstance: "deepseek-official", adapter: "openai-compatible", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", apiKey: "deep-secret" },
  { id: "kimi-k3-official", tier: "kimi-k3", provider: "moonshot", providerInstance: "moonshot-official", adapter: "openai-compatible", model: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1", apiKey: "kimi-secret" },
];

const input: GenerateAIInput = {
  task: "notes-summary",
  messages: [{ role: "user", content: "private prompt content" }],
  responseFormat: { type: "text" },
};

type Action = ProviderGenerateResult | AIError;

class ScriptedAdapter implements AIProviderAdapter {
  calls: string[] = [];
  private readonly actions: Action[];
  private readonly afterCall?: () => void;
  constructor(actions: Action[], afterCall?: () => void) {
    this.actions = actions;
    this.afterCall = afterCall;
  }
  async generate(candidate: ModelCandidate): Promise<ProviderGenerateResult> {
    this.calls.push(candidate.id);
    this.afterCall?.();
    const action = this.actions.shift();
    if (!action) throw new Error("Missing scripted action");
    if (action instanceof AIError) throw action;
    return action;
  }
  async stream(candidate: ModelCandidate, _input: GenerateAIInput, _context: unknown, onDelta: (text: string) => Promise<void>): Promise<ProviderGenerateResult> {
    const result = await this.generate(candidate);
    await onDelta(result.text);
    return result;
  }
}

function adapters(adapter: AIProviderAdapter) {
  return { "openai-compatible": adapter } as const;
}

const success = (text = "ok"): ProviderGenerateResult => ({ text, statusCode: 200, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } });
const fallback500 = () => new AIError("MODEL_UNAVAILABLE", { statusCode: 500, fallbackAllowed: true });
const rateLimit = () => new AIError("RATE_LIMITED", { statusCode: 429, retryable: true, fallbackAllowed: true });

test("production model chain uses official DeepSeek then Kimi endpoints", () => {
  const chain = getDefaultModelChain({ DEEPSEEK_API_KEY: "deep-key", KIMI_API_KEY: "kimi-key" });
  assert.deepEqual(chain.map(({ id, model, baseUrl }) => ({ id, model, baseUrl })), [
    { id: "deepseek-v4-flash-official", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" },
    { id: "kimi-k3-official", model: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" },
  ]);
});

test("production routing always tries DeepSeek before Kimi", async () => {
  const adapter = new ScriptedAdapter([fallback500(), success()]);
  const result = await generateAI(input, {
    env: {
      DEEPSEEK_API_KEY: "deepseek-secret",
      KIMI_API_KEY: "kimi-secret",
    },
    adapters: adapters(adapter),
    jitterMs: () => 0,
  });
  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official", "kimi-k3-official"]);
  assert.equal(result.selectedTier, "deepseek-flash");
  assert.equal(result.selectionSource, "fixed-chain");
  assert.equal(result.provider, "moonshot");
  assert.equal(result.model, "kimi-k3");
});

test("first candidate succeeds without fallback", async () => {
  const adapter = new ScriptedAdapter([success()]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter), jitterMs: () => 0 });
  assert.equal(result.fallbackIndex, 0);
  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official"]);
});

test("Yuzi uses its bounded generation policy", () => {
  assert.deepEqual(resolveTaskPolicy({ ...input, task: "yuzi-turn" }), {
    timeoutMs: 25_000,
    totalBudgetMs: 55_000,
    maxOutputTokens: 700,
    temperature: 0.72,
  });
  assert.equal(resolveTaskPolicy({ ...input, task: "yuzi-turn", maxOutputTokens: 2_000 }).maxOutputTokens, 700);
});

test("429 retries once, then falls back to Kimi K3", async () => {
  const adapter = new ScriptedAdapter([rateLimit(), rateLimit(), success("second")]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter), sleep: async () => {}, jitterMs: () => 0 });
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official", "deepseek-v4-flash-official", "kimi-k3-official"]);
});

test("all candidate failures return the unified terminal error", async () => {
  const adapter = new ScriptedAdapter([fallback500(), fallback500()]);
  await assert.rejects(
    generateAI(input, { candidates, adapters: adapters(adapter) }),
    (error: unknown) => error instanceof AIError && error.code === "ALL_CANDIDATES_FAILED" && error.attempts === 2,
  );
});

test("non-fallback provider parameter errors stop immediately", async () => {
  const adapter = new ScriptedAdapter([new AIError("UNKNOWN", { statusCode: 400 })]);
  await assert.rejects(generateAI(input, { candidates, adapters: adapters(adapter) }), (error: unknown) => error instanceof AIError && error.code === "UNKNOWN");
  assert.equal(adapter.calls.length, 1);
});

test("provider authentication failures fall back to the next capability", async () => {
  const adapter = new ScriptedAdapter([
    new AIError("UNAUTHORIZED", { statusCode: 401, fallbackAllowed: true }),
    success(),
  ]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter), jitterMs: () => 0 });
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official", "kimi-k3-official"]);
});

test("total budget expiry stops later candidates", async () => {
  let clock = 0;
  const adapter = new ScriptedAdapter([fallback500()], () => { clock = 80_000; });
  await assert.rejects(
    generateAI(input, { candidates, adapters: adapters(adapter), now: () => clock }),
    (error: unknown) => error instanceof AIError && error.code === "TIMEOUT",
  );
  assert.equal(adapter.calls.length, 1);
});

test("invalid JSON output falls back and returns parsed JSON data", async () => {
  const adapter = new ScriptedAdapter([success("```json\n{broken}\n```"), success("```json\n{\"answer\":42}\n```")]);
  const result = await generateAI({ ...input, responseFormat: { type: "json" } }, { candidates, adapters: adapters(adapter) });
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(result.json, { answer: 42 });
  assert.equal(result.text, "{\"answer\":42}");
});

test("missing provider environment variables fail as configuration errors", async () => {
  await assert.rejects(generateAI(input, { env: {} }), (error: unknown) => error instanceof AIError && error.code === "MISSING_CONFIGURATION");
});

test("structured logs contain no API keys or complete prompt", async () => {
  const entries: unknown[] = [];
  const logger: AILogger = { write: (entry) => { entries.push(entry); } };
  await generateAI(input, { candidates, adapters: adapters(new ScriptedAdapter([success()])), logger });
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /kimi-secret|deep-secret|private prompt content/);
  assert.match(serialized, /"inputChars":22/);
});

test("records one sanitized event per provider attempt, including fallback", async () => {
  const rows: unknown[][] = [];
  const db: LLMUsageDatabase = { prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { rows.push(values); }, all: async () => ({ results: [] }), first: async () => null }) }) };
  const adapter = new ScriptedAdapter([fallback500(), success()]);
  await generateAI({ ...input, context: { source: "notes", operation: "summarize", metadata: { ignored: true } } }, {
    candidates, adapters: adapters(adapter), telemetryDb: db, scheduleTelemetry: (task) => { void task; },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rows.length, 2);
  assert.equal(rows[0][3], "notes");
  assert.equal(rows[0][14], "error");
  assert.equal(rows[1][14], "success");
  assert.equal(rows[1][17], 1);
  assert.doesNotMatch(JSON.stringify(rows), /private prompt content/);
});

test("normalizes provider usage without guessing missing tokens or cost", () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 12, cachedInputTokens: 4 }), { inputTokens: 12, cachedInputTokens: 4, totalTokens: 12 });
  assert.equal(estimateLLMCost({ provider: "unknown", model: "unknown" }), undefined);
});

test("client-controlled provider configuration fields are rejected", () => {
  assert.throws(
    () => validateGenerateAIInput({ ...input, provider: "attacker", model: "arbitrary", baseURL: "https://evil.example" }),
    (error: unknown) => error instanceof AIError && error.code === "INVALID_INPUT",
  );
});

test("empty messages and overlong content are rejected before routing", () => {
  assert.throws(() => validateGenerateAIInput({ task: "notes-summary", messages: [] }), (error: unknown) => error instanceof AIError && error.code === "INVALID_INPUT");
  assert.throws(
    () => validateGenerateAIInput({ task: "notes-summary", messages: [{ role: "user", content: "x".repeat(24_001) }] }),
    (error: unknown) => error instanceof AIError && error.code === "CONTEXT_TOO_LONG",
  );
});

test("OpenAI-compatible adapter preserves the native fetch receiver", async () => {
  let receiver: unknown;
  const fetcher = async function (this: unknown): Promise<Response> {
    receiver = this;
    return Response.json({
      choices: [{ message: { content: "receiver-ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  } as typeof fetch;
  const result = await new OpenAICompatibleAdapter().generate(candidates[0], input, {
    requestId: "receiver-test",
    timeoutMs: 1_000,
    fetcher,
  });
  assert.equal(receiver, globalThis);
  assert.equal(result.text, "receiver-ok");
});

test("OpenAI-compatible adapter parses fragmented provider SSE incrementally", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"stream\"}}]}",
    "\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2,\"total_tokens\":4}}\n\ndata: [DONE]\n\n",
  ];
  let requestBody: Record<string, unknown> | undefined;
  let receiver: unknown;
  const fetcher = async function (this: unknown, _url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    receiver = this;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  } as typeof fetch;
  const deltas: string[] = [];
  const result = await new OpenAICompatibleAdapter().stream(candidates[0], input, {
    requestId: "stream-receiver-test", timeoutMs: 1_000, fetcher,
  }, async (delta) => { deltas.push(delta); });
  assert.equal(receiver, globalThis);
  assert.equal(requestBody?.stream, true);
  assert.deepEqual(deltas, ["hello ", "stream"]);
  assert.equal(result.text, "hello stream");
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 2, totalTokens: 4 });
});

test("stream router resets partial output before JSON fallback", async () => {
  const adapter = new ScriptedAdapter([success("{broken"), success("{\"answer\":42}")]);
  const events: Array<{ type: string; value?: string }> = [];
  const result = await streamAI({ ...input, responseFormat: { type: "json" } }, {
    attempt: async ({ model }) => { events.push({ type: "attempt", value: model }); },
    delta: async (text) => { events.push({ type: "delta", value: text }); },
    reset: async (reason) => { events.push({ type: "reset", value: reason }); },
  }, { candidates, adapters: adapters(adapter) });
  assert.deepEqual(events, [
    { type: "attempt", value: "deepseek-v4-flash" },
    { type: "delta", value: "{broken" },
    { type: "reset", value: "fallback" },
    { type: "attempt", value: "kimi-k3" },
    { type: "delta", value: "{\"answer\":42}" },
  ]);
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(result.json, { answer: 42 });
});

test("browser stream client parses fragmented SSE through the terminal event", async () => {
  const encoder = new TextEncoder();
  const result = success("client-ok");
  const events: AIStreamEvent[] = [
    { type: "start", requestId: "client-stream" },
    { type: "delta", requestId: "client-stream", text: "client-ok" },
    { type: "done", requestId: "client-stream", data: { text: result.text, provider: "deepseek", model: "deepseek-v4-flash", fallbackIndex: 0, latencyMs: 10 } },
  ];
  const wire = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const split = [wire.slice(0, 17), wire.slice(17, 63), wire.slice(63)];
  const fetcher = async (): Promise<Response> => new Response(new ReadableStream({
    pull(controller) {
      const chunk = split.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  const received: AIStreamEvent[] = [];
  for await (const event of streamAIClient(input, { fetcher: fetcher as typeof fetch })) received.push(event);
  assert.deepEqual(received, events);
});
