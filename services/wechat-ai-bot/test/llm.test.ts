import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { LlmClient } from "../src/llm.js";

const messages = [{ role: "user" as const, content: "hello" }];

function client(status: number, content = ""): OpenAI {
  return new OpenAI({
    apiKey: "test-key",
    baseURL: "https://provider.test/v1",
    maxRetries: 0,
    fetch: async () => new Response(status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : JSON.stringify({ error: { message: "temporarily unavailable" } }), { status, headers: { "content-type": "application/json" } }),
  });
}

function options(createClient: (options: { apiKey: string; baseURL: string; timeout: number }) => OpenAI) {
  return {
    deepseekApiKey: "deepseek-key",
    kimiApiKey: "kimi-key",
    systemPromptFile: "/private/tmp/missing-wechat-system-prompt.md",
    timeoutMs: 1_000,
    maxRetries: 0,
    createClient,
  };
}

test("falls back from DeepSeek to Kimi after a recoverable provider failure", async () => {
  const baseUrls: string[] = [];
  const llm = new LlmClient(options(({ baseURL }) => {
    baseUrls.push(baseURL);
    return baseURL.includes("deepseek") ? client(503) : client(200, "Kimi reply");
  }));

  assert.equal(await llm.complete(messages), "Kimi reply");
  assert.deepEqual(baseUrls, ["https://api.deepseek.com", "https://api.moonshot.ai/v1"]);
});

test("does not need Kimi to run with DeepSeek only", async () => {
  const llm = new LlmClient({
    deepseekApiKey: "deepseek-key",
    systemPromptFile: "/private/tmp/missing-wechat-system-prompt.md",
    timeoutMs: 1_000,
    maxRetries: 0,
    createClient: () => client(200, "DeepSeek reply"),
  });

  assert.equal(await llm.complete(messages), "DeepSeek reply");
});
