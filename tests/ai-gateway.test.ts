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
import { enforceAIAccess, enforceAITaskScope } from "../functions/_lib/ai/abuse.ts";

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

test("production model chain appends the configured OpenAI text fallback", () => {
  const env = {
    DEEPSEEK_API_KEY: "deep-key",
    KIMI_API_KEY: "kimi-key",
    OPENAI_TEXT_BASE_URL: "https://text.example/v1",
    OPENAI_TEXT_API_KEY: "text-key",
    OPENAI_TEXT_MODEL: "text-model",
  } as Parameters<typeof getDefaultModelChain>[0] & Record<"OPENAI_TEXT_BASE_URL" | "OPENAI_TEXT_API_KEY" | "OPENAI_TEXT_MODEL", string>;
  const chain = getDefaultModelChain(env);

  assert.deepEqual(chain.map(({ id, tier, provider, providerInstance, model, baseUrl }) => ({ id, tier, provider, providerInstance, model, baseUrl })), [
    { id: "deepseek-v4-flash-official", tier: "deepseek-flash", provider: "deepseek", providerInstance: "deepseek-official", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" },
    { id: "kimi-k3-official", tier: "kimi-k3", provider: "moonshot", providerInstance: "moonshot-official", model: "kimi-k3", baseUrl: "https://api.moonshot.ai/v1" },
    { id: "openai-text-configured", tier: "openai-text", provider: "openai", providerInstance: "openai-text-configured", model: "text-model", baseUrl: "https://text.example/v1" },
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

test("production routing reaches the configured OpenAI text fallback", async () => {
  const chain = getDefaultModelChain({
    DEEPSEEK_API_KEY: "deep-key",
    KIMI_API_KEY: "kimi-key",
    OPENAI_TEXT_BASE_URL: "https://text.example/v1",
    OPENAI_TEXT_API_KEY: "text-key",
    OPENAI_TEXT_MODEL: "text-model",
  });
  const adapter = new ScriptedAdapter([fallback500(), fallback500(), success("third")]);
  const result = await generateAI(input, {
    candidates: chain,
    adapters: adapters(adapter),
    jitterMs: () => 0,
  });

  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official", "kimi-k3-official", "openai-text-configured"]);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "text-model");
  assert.equal(result.fallbackIndex, 2);
});

test("Market Agent routing keeps DeepSeek as the primary candidate", async () => {
  const adapter = new ScriptedAdapter([success("market-agent")]);
  const result = await generateAI({ ...input, task: "market-agent-close-review" }, {
    env: {
      DEEPSEEK_API_KEY: "deep-key",
      KIMI_API_KEY: "kimi-key",
      OPENAI_TEXT_BASE_URL: "https://text.example/v1",
      OPENAI_TEXT_API_KEY: "text-key",
      OPENAI_TEXT_MODEL: "text-model",
    },
    adapters: adapters(adapter),
    jitterMs: () => 0,
  });

  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official"]);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.selectedTier, "deepseek-flash");
  assert.equal(result.selectionReason, "market-agent-deepseek-primary");
});

test("Market Agent routing uses its configured OpenAI fast fallback immediately after DeepSeek", async () => {
  const adapter = new ScriptedAdapter([
    new AIError("TIMEOUT", { fallbackAllowed: true }),
    success("fast fallback"),
  ]);
  const result = await generateAI({ ...input, task: "market-agent-close-review" }, {
    env: {
      DEEPSEEK_API_KEY: "deep-key",
      KIMI_API_KEY: "kimi-key",
      OPENAI_TEXT_BASE_URL: "https://text.example/v1",
      OPENAI_TEXT_API_KEY: "text-key",
      OPENAI_TEXT_MODEL: "text-model",
      MARKET_AGENT_OPENAI_FALLBACK_MODEL: "fast-model",
    },
    adapters: adapters(adapter),
    jitterMs: () => 0,
  });

  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official", "market-agent-openai-fallback"]);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "fast-model");
  assert.equal(result.fallbackIndex, 1);
});

test("Market Agent retries malformed structured output on primary DeepSeek before fallback", async () => {
  const adapter = new ScriptedAdapter([
    success('{"status":"partial"'),
    success('{"status":"success"}'),
  ]);
  const result = await generateAI({
    ...input,
    task: "market-agent-close-review",
    responseFormat: { type: "json" },
  }, {
    candidates,
    adapters: adapters(adapter),
    sleep: async () => {},
    jitterMs: () => 0,
  });

  assert.deepEqual(adapter.calls, ["deepseek-v4-flash-official", "deepseek-v4-flash-official"]);
  assert.equal(result.provider, "deepseek");
  assert.equal(result.fallbackIndex, 0);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.json, { status: "success" });
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

test("Market Agent may use only its bounded Gateway tasks", () => {
  assert.deepEqual(resolveTaskPolicy({ ...input, task: "market-agent-answer" }), {
    timeoutMs: 80_000,
    totalBudgetMs: 90_000,
    maxOutputTokens: 2_600,
    temperature: 0.2,
  });
  assert.equal(resolveTaskPolicy({ ...input, task: "market-agent-answer", maxOutputTokens: 2_600 }).maxOutputTokens, 2_600);
  assert.deepEqual(resolveTaskPolicy({ ...input, task: "market-agent-close-review" }), {
    timeoutMs: 80_000,
    totalBudgetMs: 90_000,
    maxOutputTokens: 4_800,
    temperature: 0,
  });
  assert.equal(resolveTaskPolicy({ ...input, task: "market-agent-close-review", maxOutputTokens: 4_800 }).maxOutputTokens, 4_800);
  assert.doesNotThrow(() =>
    enforceAITaskScope("market-agent", "market-agent-close-review", "market-agent-worker"),
  );
  assert.doesNotThrow(() =>
    enforceAITaskScope("market-agent", "market-agent-answer", "market-agent-worker"),
  );
  assert.throws(
    () => enforceAITaskScope("market-agent", "portfolio-review", "market-agent-worker"),
    (error: unknown) => error instanceof AIError && error.code === "UNAUTHORIZED",
  );
  assert.throws(
    () => enforceAITaskScope("market-agent", "market-agent-answer", "other-service"),
    (error: unknown) => error instanceof AIError && error.code === "UNAUTHORIZED",
  );
});

test("Signal authenticates with the shared Runtime transport token and stays task-scoped", async () => {
  const caller = await enforceAIAccess(new Request("https://beta.zxlab.pages.dev/api/ai/stream", {
    headers: { authorization: "Bearer runtime-transport-token" },
  }), {
    ENVIRONMENT: "production",
    ZX_RUNTIME_SERVICE_TOKEN: "runtime-transport-token",
  });

  assert.equal(caller, "signal");
  assert.doesNotThrow(() => enforceAITaskScope(caller, "signal-annotation-reply", "signal-worker"));
  assert.throws(
    () => enforceAITaskScope(caller, "notes-summary", "signal-worker"),
    (error: unknown) => error instanceof AIError && error.code === "UNAUTHORIZED",
  );
  assert.throws(
    () => enforceAITaskScope(caller, "signal-annotation-reply", "other-service"),
    (error: unknown) => error instanceof AIError && error.code === "UNAUTHORIZED",
  );
});

test("Signal editorial filtering allows DeepSeek enough time for reasoning output", () => {
  assert.deepEqual(resolveTaskPolicy({ ...input, task: "signal-editorial-filter" }), {
    timeoutMs: 60_000,
    totalBudgetMs: 120_000,
    maxOutputTokens: 8_000,
    temperature: 0,
  });
  assert.equal(resolveTaskPolicy({ ...input, task: "signal-briefing" }).maxOutputTokens, 12_000);
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

test("DeepSeek structured requests disable hidden thinking and accept text parts", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { content: [{ type: "text", text: "{\"ok\":true}" }] } }] });
  };
  const result = await new OpenAICompatibleAdapter().generate(candidates[0], {
    ...input,
    responseFormat: { type: "json" },
  }, { requestId: "deepseek-json-test", timeoutMs: 1_000, fetcher });
  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
  assert.equal(result.text, "{\"ok\":true}");
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

test("OpenAI-compatible adapter tolerates large hidden reasoning before visible JSON", async () => {
  const encoder = new TextEncoder();
  const reasoning = "x".repeat(540_000);
  const wire = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: reasoning } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '{"positions":[]}' } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const fetcher = async (): Promise<Response> => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(wire)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
  const result = await new OpenAICompatibleAdapter().stream(candidates[0], { ...input, responseFormat: { type: "json" } }, {
    requestId: "large-reasoning-test", timeoutMs: 1_000, fetcher,
  }, async () => {});
  assert.equal(result.text, '{"positions":[]}');
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
