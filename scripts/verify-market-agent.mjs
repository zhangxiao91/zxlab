#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  parseRequestArguments,
  performDebugRequest,
  readDebugAccessCredentials,
} from "./zxlab-debug-request.mjs";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const BETA_GATEWAY_URL = "https://beta.zxlab.pages.dev/api/ai/generate";
const DEFAULT_INSTRUMENT = "SSE:600000";
const TERMINAL_STATUSES = new Set(["success", "partial", "failed"]);
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export async function inspectMarketAgentEnvironment({
  accountId,
  expectedCommit,
  localGatewayUrl,
  fetchJson,
}) {
  if (!accountId) throw new Error("Cloudflare account ID is required.");
  const base = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}`;
  const [projectPayload, deploymentsPayload, workerPayload] = await Promise.all([
    fetchJson(`${base}/pages/projects/zxlab`),
    fetchJson(`${base}/pages/projects/zxlab/deployments?env=preview&per_page=20`),
    fetchJson(`${base}/workers/scripts/zxlab-market-agent-beta/settings`),
  ]);
  const previewConfig = projectPayload?.result?.deployment_configs?.preview ?? {};
  const productionConfig = projectPayload?.result?.deployment_configs?.production ?? {};
  const previewVars = previewConfig.env_vars ?? {};
  const bindings = Array.isArray(workerPayload?.result?.bindings) ? workerPayload.result.bindings : [];
  const deployments = Array.isArray(deploymentsPayload?.result) ? deploymentsPayload.result : [];
  const betaDeployment = deployments.find((deployment) =>
    deployment?.latest_stage?.status === "success"
      && deployment?.deployment_trigger?.metadata?.branch === "beta");
  const deployedCommit = betaDeployment?.deployment_trigger?.metadata?.commit_hash;
  const deployedGatewayUrl = bindingText(bindings, "MARKET_AGENT_GATEWAY_URL");
  const previewMarketAgent = serviceName(previewConfig.services, "MARKET_AGENT_SERVICE");
  const productionMarketAgent = serviceName(productionConfig.services, "MARKET_AGENT_SERVICE");

  const checks = [
    check("local gateway URL", localGatewayUrl === BETA_GATEWAY_URL, localGatewayUrl === BETA_GATEWAY_URL ? "beta" : "must target beta Gateway"),
    check("Preview DEEPSEEK_API_KEY", previewVars.DEEPSEEK_API_KEY?.type === "secret_text", "secret binding present"),
    check("Preview MARKET_AGENT_GATEWAY_TOKEN", previewVars.MARKET_AGENT_GATEWAY_TOKEN?.type === "secret_text", "secret binding present"),
    check(
      "Preview DeepSeek base URL",
      previewVars.DEEPSEEK_BASE_URL === undefined || previewVars.DEEPSEEK_BASE_URL?.value === "https://api.deepseek.com",
      previewVars.DEEPSEEK_BASE_URL === undefined ? "default" : "canonical",
    ),
    check(
      "latest successful beta deployment",
      Boolean(betaDeployment) && (!expectedCommit || deployedCommit === expectedCommit),
      expectedCommit ? (deployedCommit === expectedCommit ? "expected commit" : "commit mismatch") : "successful beta deployment present",
    ),
    check("Preview Market Agent binding", previewMarketAgent === "zxlab-market-agent-beta", previewMarketAgent === "zxlab-market-agent-beta" ? "isolated beta Worker" : "must bind zxlab-market-agent-beta"),
    check("Production Market Agent binding", productionMarketAgent === "zxlab-market-agent", productionMarketAgent === "zxlab-market-agent" ? "Production unchanged" : "must remain zxlab-market-agent"),
    check("deployed Worker gateway URL", deployedGatewayUrl === BETA_GATEWAY_URL, deployedGatewayUrl === BETA_GATEWAY_URL ? "beta" : "must target beta Gateway"),
    check("deployed Worker gateway token", bindingType(bindings, "MARKET_AGENT_GATEWAY_TOKEN") === "secret_text", "secret binding present"),
  ];
  const warnings = Object.keys(previewVars)
    .filter((name) => /^DEEPSEEK_.+_MODEL$/.test(name))
    .map((name) => `${name} is a stale DeepSeek model override; remove it from Preview unless explicitly required.`);

  return { ok: checks.every((item) => item.ok), checks, warnings };
}

export async function verifyMarketAgentRun({
  request,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  instrument = DEFAULT_INSTRUMENT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const idempotencyKey = `market-agent-deepseek-acceptance:${Date.now()}:${crypto.randomUUID()}`;
  const created = await request({
    method: "POST",
    path: "/api/private/market-agent/runs",
    body: JSON.stringify({ workflow: "close_review", instrumentId: instrument, idempotencyKey }),
  });
  if (created.status !== 202) throw new Error(`Market Agent Run creation failed with HTTP ${created.status}.`);
  const creation = parseBody(created.body, "Run creation");
  const runId = boundedString(creation.runId, 128);
  if (!runId) throw new Error("Market Agent Run creation did not return a valid runId.");

  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() <= deadline) {
    const response = await request({ method: "GET", path: `/api/private/market-agent/runs/${encodeURIComponent(runId)}` });
    if (response.status !== 200) throw new Error(`Market Agent Run lookup failed with HTTP ${response.status}.`);
    run = parseBody(response.body, "Run lookup");
    if (TERMINAL_STATUSES.has(run.status)) break;
    await wait(pollIntervalMs);
  }
  if (!run || !TERMINAL_STATUSES.has(run.status)) throw new Error(`Market Agent Run ${runId} did not reach a terminal state before timeout.`);

  const narration = run?.result?.outcome?.narration;
  const sourceIsModel = narration?.source === "model" || narration?.source === "model_repaired";
  const primaryDeepSeek = (run.status === "success" || run.status === "partial")
    && sourceIsModel
    && narration?.provider === "deepseek"
    && typeof narration?.model === "string"
    && narration.model.toLowerCase().includes("deepseek")
    && narration?.fallbackIndex === 0
    && Boolean(boundedString(narration?.gatewayRequestId, 128));
  if (!primaryDeepSeek) {
    throw new Error(`Market Agent acceptance failed: Run ${runId} did not complete on primary DeepSeek.`);
  }

  return {
    ok: true,
    runId,
    status: run.status,
    source: narration.source,
    provider: narration.provider,
    model: narration.model,
    fallbackIndex: narration.fallbackIndex,
    gatewayRequestId: narration.gatewayRequestId,
  };
}

function check(name, ok, detail) { return { name, ok, detail }; }
function binding(bindings, name) { return bindings.find((item) => item?.name === name); }
function bindingText(bindings, name) { const item = binding(bindings, name); return item?.text ?? item?.value; }
function bindingType(bindings, name) { return binding(bindings, name)?.type; }
function serviceName(services, name) { const item = services?.[name]; return item?.service ?? item?.service_name; }
function boundedString(value, maxLength) { return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined; }
function parseBody(body, label) {
  try { return JSON.parse(body); }
  catch { throw new Error(`${label} returned invalid JSON.`); }
}

async function readLocalGatewayUrl() {
  const config = await readFile(new URL("../apps/market-agent-worker/wrangler.beta.jsonc", import.meta.url), "utf8");
  return config.match(/"MARKET_AGENT_GATEWAY_URL"\s*:\s*"([^"]+)"/)?.[1];
}

async function cloudflareFetcher(token, url) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || payload?.success === false) throw new Error(`Cloudflare inspection failed with HTTP ${response.status}.`);
  return payload;
}

async function resolveAccountId(token) {
  const payload = await cloudflareFetcher(token, `${CLOUDFLARE_API}/accounts?per_page=50`);
  const accounts = Array.isArray(payload?.result) ? payload.result : [];
  if (accounts.length !== 1 || !accounts[0]?.id) throw new Error("Set CLOUDFLARE_ACCOUNT_ID when the token can access zero or multiple accounts.");
  return accounts[0].id;
}

async function debugRequest(input, credentials) {
  const args = ["--method", input.method, "--path", input.path];
  if (input.body !== undefined) args.push("--body", input.body);
  return performDebugRequest(parseRequestArguments(args), credentials);
}

function printUsage() {
  console.log(`Market Agent beta verification

Usage:
  npm run verify:market-agent:env -- [--commit <git-sha>]
  npm run verify:market-agent:run -- [--instrument SSE:600000]

The environment check reads Cloudflare metadata using CLOUDFLARE_API_TOKEN and
never prints secret values. The Run check reads the dedicated beta Access
credentials directly from macOS Keychain.`);
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") return printUsage();
  if (command === "env") {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required for the environment check.");
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || await resolveAccountId(token);
    const report = await inspectMarketAgentEnvironment({
      accountId,
      expectedCommit: flag(args, "--commit"),
      localGatewayUrl: await readLocalGatewayUrl(),
      fetchJson: (url) => cloudflareFetcher(token, url),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const credentials = readDebugAccessCredentials();
    const report = await verifyMarketAgentRun({
      instrument: flag(args, "--instrument") ?? DEFAULT_INSTRUMENT,
      request: (input) => debugRequest(input, credentials),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Market Agent verification failed.");
    process.exitCode = 1;
  });
}
