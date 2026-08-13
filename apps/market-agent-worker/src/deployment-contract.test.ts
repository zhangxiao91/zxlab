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
  };
  const productionConfig = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
    name: string;
    vars: { MARKET_AGENT_GATEWAY_URL?: string };
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
});
