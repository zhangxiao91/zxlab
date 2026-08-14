import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Market Agent beta calls the beta unified gateway without changing Production", async () => {
  const betaConfig = JSON.parse(await readFile(new URL("../wrangler.beta.jsonc", import.meta.url), "utf8")) as {
    name: string;
    d1_databases: Array<{ database_name: string }>;
    queues: { producers: Array<{ queue: string }> };
    triggers?: { crons?: string[] };
    vars: { MARKET_AGENT_GATEWAY_URL?: string };
    secrets: { required: string[] };
  };
  const productionConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
    name: string;
    vars: { MARKET_AGENT_GATEWAY_URL?: string };
    secrets: { required: string[] };
  };
  assert.equal(betaConfig.name, "zxlab-market-agent-beta");
  assert.equal(
    betaConfig.vars.MARKET_AGENT_GATEWAY_URL,
    "https://beta.zxlab.pages.dev/api/ai/generate",
  );
  assert.equal(betaConfig.d1_databases[0]?.database_name, "market-agent-beta");
  assert.equal(betaConfig.queues.producers[0]?.queue, "market-agent-runs-beta");
  assert.equal(betaConfig.triggers, undefined);
  assert.equal(productionConfig.name, "zxlab-market-agent");
  assert.equal(productionConfig.vars.MARKET_AGENT_GATEWAY_URL, "https://zx-dx.xyz/api/ai/generate");
  assert.ok(betaConfig.secrets.required.includes("MARKET_AGENT_MEMORY_TOKEN"));
  assert.ok(productionConfig.secrets.required.includes("MARKET_AGENT_MEMORY_TOKEN"));
});

test("Market Agent uses its retrieve-only identity for Signal Memory", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /function contextReaderFor\(env: Env\): SignalMemoryAdapter \{ return new SignalMemoryAdapter\(\{[^}]*token: env\.MARKET_AGENT_MEMORY_TOKEN/);
  assert.doesNotMatch(source, /function contextReaderFor\(env: Env\): SignalMemoryAdapter \{ return new SignalMemoryAdapter\(\{[^}]*token: env\.ZX_RUNTIME_SERVICE_TOKEN/);
});
