import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateAIInput } from "../src/lib/ai/types.ts";
import type { ModelCandidate } from "../functions/_lib/ai/config.ts";
import { AIError } from "../functions/_lib/ai/errors.ts";
import type { AILogger } from "../functions/_lib/ai/logger.ts";
import { OpenAICompatibleAdapter } from "../functions/_lib/ai/providers/openai-compatible.ts";
import type { AIProviderAdapter, ProviderGenerateResult } from "../functions/_lib/ai/providers/types.ts";
import { generateAI } from "../functions/_lib/ai/router.ts";
import { validateGenerateAIInput } from "../functions/_lib/ai/validation.ts";
import { estimateLLMCost, normalizeUsage, type LLMUsageDatabase } from "../functions/_lib/ai/telemetry.ts";

const candidates: ModelCandidate[] = [
  { id: "provider1-gpt-5.6", provider: "provider1", adapter: "openai-compatible", model: "p1-56", baseUrl: "https://p1.example/v1", apiKey: "p1-secret" },
  { id: "provider1-gpt-5.5", provider: "provider1", adapter: "openai-compatible", model: "p1-55", baseUrl: "https://p1.example/v1", apiKey: "p1-secret" },
  { id: "provider2-gpt-5.5", provider: "provider2", adapter: "openai-compatible", model: "p2-55", baseUrl: "https://p2.example/v1", apiKey: "p2-secret" },
  { id: "deepseek-v4-pro", provider: "deepseek", adapter: "deepseek-compatible", model: "deepseek-v4-pro", baseUrl: "https://deepseek.example/v1", apiKey: "deep-secret" },
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
}

function adapters(adapter: AIProviderAdapter) {
  return { "openai-compatible": adapter, "deepseek-compatible": adapter } as const;
}

const success = (text = "ok"): ProviderGenerateResult => ({ text, statusCode: 200, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } });
const fallback500 = () => new AIError("MODEL_UNAVAILABLE", { statusCode: 500, fallbackAllowed: true });
const rateLimit = () => new AIError("RATE_LIMITED", { statusCode: 429, retryable: true, fallbackAllowed: true });

test("first candidate succeeds without fallback", async () => {
  const adapter = new ScriptedAdapter([success()]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter), jitterMs: () => 0 });
  assert.equal(result.fallbackIndex, 0);
  assert.deepEqual(adapter.calls, ["provider1-gpt-5.6"]);
});

test("429 retries once, then falls back to Provider 1 GPT-5.5", async () => {
  const adapter = new ScriptedAdapter([rateLimit(), rateLimit(), success("second")]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter), sleep: async () => {}, jitterMs: () => 0 });
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(adapter.calls, ["provider1-gpt-5.6", "provider1-gpt-5.6", "provider1-gpt-5.5"]);
});

test("Provider 2 succeeds after both Provider 1 candidates fail", async () => {
  const adapter = new ScriptedAdapter([fallback500(), fallback500(), success()]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter) });
  assert.equal(result.fallbackIndex, 2);
  assert.equal(result.provider, "provider2");
});

test("DeepSeek succeeds after the first three candidates fail", async () => {
  const adapter = new ScriptedAdapter([fallback500(), fallback500(), fallback500(), success()]);
  const result = await generateAI(input, { candidates, adapters: adapters(adapter) });
  assert.equal(result.fallbackIndex, 3);
  assert.equal(result.provider, "deepseek");
});

test("all candidate failures return the unified terminal error", async () => {
  const adapter = new ScriptedAdapter([fallback500(), fallback500(), fallback500(), fallback500()]);
  await assert.rejects(
    generateAI(input, { candidates, adapters: adapters(adapter) }),
    (error: unknown) => error instanceof AIError && error.code === "ALL_CANDIDATES_FAILED" && error.attempts === 4,
  );
});

test("non-fallback provider parameter errors stop immediately", async () => {
  const adapter = new ScriptedAdapter([new AIError("UNKNOWN", { statusCode: 400 })]);
  await assert.rejects(generateAI(input, { candidates, adapters: adapters(adapter) }), (error: unknown) => error instanceof AIError && error.code === "UNKNOWN");
  assert.equal(adapter.calls.length, 1);
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
  assert.doesNotMatch(serialized, /p1-secret|deep-secret|private prompt content/);
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
