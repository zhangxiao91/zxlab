import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectMarketAgentEnvironment,
  verifyMarketAgentRun,
} from "./verify-market-agent.mjs";

test("environment inspection verifies beta Pages and Worker contracts without secret values", async () => {
  const report = await inspectMarketAgentEnvironment({
    accountId: "account-1",
    expectedCommit: "commit-1",
    localGatewayUrl: "https://beta.zxlab.pages.dev/api/ai/generate",
    fetchJson: async (url) => {
      if (url.endsWith("/pages/projects/zxlab")) return {
        result: { deployment_configs: {
          preview: {
            env_vars: {
              DEEPSEEK_API_KEY: { type: "secret_text", value: "" },
              MARKET_AGENT_GATEWAY_TOKEN: { type: "secret_text", value: "" },
              DEEPSEEK_BASE_URL: { type: "plain_text", value: "https://api.deepseek.com" },
            },
            services: { MARKET_AGENT_SERVICE: { service: "zxlab-market-agent-beta", environment: "production" } },
          },
          production: { services: { MARKET_AGENT_SERVICE: { service: "zxlab-market-agent", environment: "production" } } },
        } },
      };
      if (url.includes("/pages/projects/zxlab/deployments")) return {
        result: [{ latest_stage: { status: "success" }, deployment_trigger: { metadata: { branch: "beta", commit_hash: "commit-1" } } }],
      };
      if (url.endsWith("/workers/scripts/zxlab-market-agent-beta/settings")) return {
        result: { bindings: [
          { name: "MARKET_AGENT_GATEWAY_URL", type: "plain_text", text: "https://beta.zxlab.pages.dev/api/ai/generate" },
          { name: "MARKET_AGENT_GATEWAY_TOKEN", type: "secret_text" },
        ] },
      };
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.deepEqual(report, { ok: true, checks: report.checks, warnings: [] });
  assert.ok(report.checks.every((check) => check.ok));
  assert.doesNotMatch(JSON.stringify(report), /secret-value/);
});

test("environment inspection rejects a Production gateway URL and stale DeepSeek override", async () => {
  const report = await inspectMarketAgentEnvironment({
    accountId: "account-1",
    expectedCommit: "commit-1",
    localGatewayUrl: "https://zx-dx.xyz/api/ai/generate",
    fetchJson: async (url) => {
      if (url.endsWith("/pages/projects/zxlab")) return { result: { deployment_configs: {
        preview: {
          env_vars: {
            DEEPSEEK_API_KEY: { type: "secret_text", value: "" },
            MARKET_AGENT_GATEWAY_TOKEN: { type: "secret_text", value: "" },
            DEEPSEEK_V4_PRO_MODEL: { type: "plain_text", value: "deepseek-v4-pro" },
          },
          services: { MARKET_AGENT_SERVICE: { service: "zxlab-market-agent", environment: "production" } },
        },
        production: { services: { MARKET_AGENT_SERVICE: { service: "zxlab-market-agent", environment: "production" } } },
      } } };
      if (url.includes("/deployments")) return { result: [{ latest_stage: { status: "success" }, deployment_trigger: { metadata: { branch: "beta", commit_hash: "commit-1" } } }] };
      return { result: { bindings: [
        { name: "MARKET_AGENT_GATEWAY_URL", type: "plain_text", text: "https://zx-dx.xyz/api/ai/generate" },
        { name: "MARKET_AGENT_GATEWAY_TOKEN", type: "secret_text" },
      ] } };
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.checks.filter((check) => !check.ok).map((check) => check.name).join(" "), /local gateway URL|Preview Market Agent binding|deployed Worker gateway URL/);
  assert.match(report.warnings.join(" "), /DEEPSEEK_V4_PRO_MODEL/);
});

test("dedicated Run acceptance requires model narration from primary DeepSeek", async () => {
  const calls = [];
  const report = await verifyMarketAgentRun({
    request: async ({ method, path }) => {
      calls.push(`${method} ${path}`);
      if (method === "POST") return { status: 202, body: JSON.stringify({ runId: "run-1", status: "queued" }) };
      return { status: 200, body: JSON.stringify({
        id: "run-1",
        status: "success",
        result: { outcome: { narration: { source: "model", provider: "deepseek", model: "deepseek-v4-flash", fallbackIndex: 0, gatewayRequestId: "gateway-1" } } },
      }) };
    },
    wait: async () => {},
  });

  assert.equal(report.ok, true);
  assert.equal(report.runId, "run-1");
  assert.equal(report.provider, "deepseek");
  assert.deepEqual(calls, ["POST /api/private/market-agent/runs", "GET /api/private/market-agent/runs/run-1"]);
});

test("dedicated Run acceptance permits evidence-limited partial results from primary DeepSeek", async () => {
  const report = await verifyMarketAgentRun({
    request: async ({ method }) => method === "POST"
      ? { status: 202, body: JSON.stringify({ runId: "run-partial" }) }
      : { status: 200, body: JSON.stringify({
          id: "run-partial",
          status: "partial",
          result: { outcome: { narration: { source: "model", provider: "deepseek", model: "deepseek-v4-flash", fallbackIndex: 0, gatewayRequestId: "gateway-partial" } } },
        }) },
    wait: async () => {},
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, "partial");
});

test("dedicated Run acceptance rejects fallback or deterministic narration", async () => {
  await assert.rejects(() => verifyMarketAgentRun({
    request: async ({ method }) => method === "POST"
      ? { status: 202, body: JSON.stringify({ runId: "run-2" }) }
      : { status: 200, body: JSON.stringify({ id: "run-2", status: "partial", result: { outcome: { narration: { source: "deterministic_fallback", provider: "openai", fallbackIndex: 1 } } } }) },
    wait: async () => {},
  }), /primary DeepSeek/);
});
