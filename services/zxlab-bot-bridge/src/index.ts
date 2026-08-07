import "dotenv/config";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { formatLatestSignal } from "./format.js";
import { runGatewayTask } from "./gateway.js";
import { askMarketAgent, marketAgentAskScopes } from "./market-agent.js";
import { fetchMarketQuotes, fetchMarketStatus } from "./market.js";
import { memoryKinds, memoryNamespaces, saveConfirmedMemory, searchCanonicalMemory } from "./memory.js";
import { calculateRiskSnapshot, parseRiskReview } from "./risk.js";
import { fetchLatestSignal } from "./signal.js";

const host = process.env.BRIDGE_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT || "8789");
const signalBaseUrl = process.env.SIGNAL_API_BASE_URL?.trim() || "https://signal-api.zx-dx.xyz";
const authToken = process.env.BRIDGE_AUTH_TOKEN?.trim();
const timeoutMs = Number(process.env.SIGNAL_REQUEST_TIMEOUT_MS || "15000");
const gatewayBaseUrl = process.env.AI_GATEWAY_BASE_URL?.trim() || "https://beta.zxlab.pages.dev";
const gatewayToken = process.env.AI_GATEWAY_ACCESS_TOKEN?.trim() || "";
const gatewayTimeoutMs = Number(process.env.AI_GATEWAY_REQUEST_TIMEOUT_MS || "90000");
const marketBaseUrl = process.env.MARKET_API_BASE_URL?.trim() || "https://beta.zxlab.pages.dev";
const marketTimeoutMs = Number(process.env.MARKET_REQUEST_TIMEOUT_MS || "15000");
const marketAgentBaseUrl = process.env.MARKET_AGENT_API_BASE_URL?.trim() || marketBaseUrl;
const marketAgentTimeoutMs = Number(process.env.MARKET_AGENT_REQUEST_TIMEOUT_MS || "15000");
const marketAgentRunWaitMs = Number(process.env.MARKET_AGENT_RUN_WAIT_MS || "120000");
const memoryBaseUrl = process.env.CANONICAL_MEMORY_API_BASE_URL?.trim() || signalBaseUrl;
const memoryToken = process.env.CANONICAL_MEMORY_API_TOKEN?.trim() || "";
const memoryTimeoutMs = Number(process.env.CANONICAL_MEMORY_REQUEST_TIMEOUT_MS || "15000");
const memoryAccessClientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
const memoryAccessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();

const instrumentId = z.string().regex(/^(?:SSE|SZSE):[0-9A-Z.]{2,20}$/);
const positionSchema = z.object({
  instrumentId,
  quantity: z.number().finite().nonnegative(),
  averageCost: z.number().finite().nonnegative().optional(),
  leverageMultiplier: z.number().finite().positive().max(10).optional(),
  themes: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});
const historySchema = z.object({
  date: z.string().trim().min(1).max(40),
  value: z.number().finite().positive(),
});
const marketAgentInstrumentId = z.string().trim().regex(/^(?:SSE|SZSE):\d{6}$/i);

function jsonText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function createServer(): McpServer {
  const server = new McpServer({ name: "zxlab-bot-bridge", version: "0.2.0" });
  server.registerTool("signal_latest", {
    title: "Latest ZX Signal",
    description: "Read the latest published ZX Signal briefing and format it for a private chat.",
    inputSchema: { detail: z.enum(["full", "summary"]).default("full") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ detail }) => {
    const briefing = await fetchLatestSignal({ baseUrl: signalBaseUrl, timeoutMs });
    const text = detail === "summary" ? `${briefing.title}\n\n${briefing.summary}` : formatLatestSignal(briefing);
    return { content: [{ type: "text", text }] };
  });
  server.registerTool("zxlab_ai_task", {
    title: "ZXLab structured AI task",
    description: "Use ZXLab's server-side AI Gateway for complex Signal or Risk work only. Ordinary conversation should continue using Memoh's own model. Provider selection, retry, fallback and usage telemetry stay inside ZXLab.",
    inputSchema: {
      domain: z.enum(["signal", "risk"]),
      instruction: z.string().trim().min(1).max(12_000),
      evidence: z.string().trim().max(24_000).optional(),
      outputFormat: z.enum(["text", "json"]).default("text"),
      maxOutputTokens: z.number().int().min(100).max(3_000).default(1_500),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ domain, instruction, evidence, outputFormat, maxOutputTokens }) => {
    const result = await runGatewayTask({
      baseUrl: gatewayBaseUrl,
      token: gatewayToken,
      timeoutMs: gatewayTimeoutMs,
    }, {
      task: domain === "signal" ? "signal-annotation-reply" : "portfolio-review",
      messages: [
        {
          role: "system",
          content: domain === "signal"
            ? "You are a ZX Signal analysis helper. Separate facts from inference, preserve source uncertainty, and never invent events."
            : "You are a read-only ZXLab risk reviewer. Use only supplied evidence, cite limitations, and never recommend or execute trades.",
        },
        {
          role: "user",
          content: `${instruction}${evidence ? `\n\nEvidence:\n${evidence}` : ""}`,
        },
      ],
      responseFormat: { type: outputFormat },
      maxOutputTokens,
      context: { source: "wechat-bot", operation: `${domain}-structured-task` },
    });
    return jsonText(result);
  });
  server.registerTool("market_status", {
    title: "China market status",
    description: "Read the current SSE or SZSE market status, source and freshness warnings.",
    inputSchema: { exchange: z.enum(["SSE", "SZSE"]) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ exchange }) => jsonText(await fetchMarketStatus({
    baseUrl: marketBaseUrl,
    timeoutMs: marketTimeoutMs,
  }, exchange)));
  server.registerTool("market_quotes", {
    title: "Current market quotes",
    description: "Read normalized current quotes with source, timestamp, quality, stale flag and warnings. Never treat stale or unavailable quotes as reliable.",
    inputSchema: { instruments: z.array(instrumentId).min(1).max(20) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ instruments }) => jsonText(await fetchMarketQuotes({
    baseUrl: marketBaseUrl,
    timeoutMs: marketTimeoutMs,
  }, [...new Set(instruments)])));
  server.registerTool("market_agent_ask", {
    title: "Evidence-bound Market Agent Ask",
    description: "Start one fixed-scope Market Agent Run and return its terminal structured result with the sealed Evidence bundle. It cannot browse arbitrary sources, plan tools, or place trades.",
    inputSchema: {
      scope: z.enum(marketAgentAskScopes),
      instrumentId: marketAgentInstrumentId.optional(),
      question: z.string().trim().min(1).max(800).optional(),
      priorRunId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,120}$/).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => jsonText(await askMarketAgent({
    baseUrl: marketAgentBaseUrl,
    accessClientId: memoryAccessClientId,
    accessClientSecret: memoryAccessClientSecret,
    timeoutMs: marketAgentTimeoutMs,
    runWaitMs: marketAgentRunWaitMs,
  }, input)));
  server.registerTool("risk_snapshot", {
    title: "Read-only portfolio risk snapshot",
    description: "Calculate a deterministic, read-only risk snapshot from user-supplied positions and ZXLab quotes. It does not connect to a broker or place orders. Reliability and freshness warnings are mandatory.",
    inputSchema: {
      positions: z.array(positionSchema).min(1).max(50),
      cash: z.number().finite().default(0),
      history: z.array(historySchema).max(1_500).optional(),
      rules: z.object({
        maxSinglePosition: z.number().positive().max(1).optional(),
        maxThemeConcentration: z.number().positive().max(3).optional(),
        maxEffectiveExposure: z.number().positive().max(10).optional(),
        maxDrawdown: z.number().positive().max(1).optional(),
      }).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ positions, cash, history, rules }) => {
    const quotes = await fetchMarketQuotes({
      baseUrl: marketBaseUrl,
      timeoutMs: marketTimeoutMs,
    }, [...new Set(positions.map((item) => item.instrumentId))]);
    return jsonText(calculateRiskSnapshot({ positions, quotes, cash, history, rules }));
  });
  server.registerTool("risk_review", {
    title: "Evidence-bound portfolio risk review",
    description: "Calculate a read-only risk snapshot, then ask ZXLab AI Gateway to explain the resulting events. The review must cite only snapshot evidence and cannot place trades.",
    inputSchema: {
      positions: z.array(positionSchema).min(1).max(50),
      cash: z.number().finite().default(0),
      history: z.array(historySchema).max(1_500).optional(),
      question: z.string().trim().min(1).max(2_000).default("解释最重要的风险事件，以及为什么任何不可靠仓位不可靠。"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ positions, cash, history, question }) => {
    const quotes = await fetchMarketQuotes({
      baseUrl: marketBaseUrl,
      timeoutMs: marketTimeoutMs,
    }, [...new Set(positions.map((item) => item.instrumentId))]);
    const snapshot = calculateRiskSnapshot({ positions, quotes, cash, history });
    const allowedEvidenceIds = new Set([
      "portfolio-history",
      ...snapshot.positions.flatMap((item) => item.evidenceIds),
    ]);
    const gateway = await runGatewayTask({
      baseUrl: gatewayBaseUrl,
      token: gatewayToken,
      timeoutMs: gatewayTimeoutMs,
    }, {
      task: "portfolio-review",
      messages: [
        {
          role: "system",
          content: "Return JSON with summary, mainRisks, unknowns, limitations. Every mainRisks item must contain title, explanation, severity and non-empty evidenceIds copied exactly from the supplied snapshot. Explain, do not recommend or execute trades.",
        },
        { role: "user", content: `${question}\n\nSnapshot:\n${JSON.stringify(snapshot)}` },
      ],
      responseFormat: { type: "json" },
      maxOutputTokens: 2_000,
      context: { source: "wechat-bot", operation: "risk-review" },
    });
    return jsonText({
      snapshot,
      review: parseRiskReview(gateway.json, allowedEvidenceIds),
      gateway: {
        provider: gateway.provider,
        model: gateway.model,
        fallbackIndex: gateway.fallbackIndex,
        requestId: gateway.requestId,
        transport: gateway.transport,
        usage: gateway.usage,
      },
    });
  });
  server.registerTool("canonical_memory_search", {
    title: "Search ZXLab canonical Memory",
    description: "Read confirmed long-term project rules and preferences from ZXLab canonical Memory. Use Memoh Graph Memory for ordinary chat context.",
    inputSchema: {
      task: z.string().trim().min(1).max(120).default("wechat-assistant"),
      namespaces: z.array(z.enum(memoryNamespaces)).min(1).max(memoryNamespaces.length).default(["zxlab", "global"]),
      query: z.string().trim().min(1).max(8_000),
      limit: z.number().int().min(1).max(30).default(12),
      tokenBudget: z.number().int().min(64).max(4_000).default(1_500),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => jsonText(await searchCanonicalMemory({
    baseUrl: memoryBaseUrl,
    token: memoryToken,
    accessClientId: memoryAccessClientId,
    accessClientSecret: memoryAccessClientSecret,
    timeoutMs: memoryTimeoutMs,
  }, input)));
  server.registerTool("canonical_memory_save_confirmed", {
    title: "Save confirmed ZXLab canonical Memory",
    description: "Write a reviewed long-term rule or preference through the ZXLab canonical Memory API. Call only after the user explicitly confirms the exact content. Never use this for ordinary chat context or inferred preferences.",
    inputSchema: {
      confirmed: z.literal(true).describe("Must be true only after explicit user confirmation of the exact content."),
      namespace: z.enum(memoryNamespaces),
      kind: z.enum(memoryKinds),
      content: z.string().trim().min(1).max(8_000),
      importance: z.number().min(0).max(1).default(0.7),
      confidence: z.number().min(0).max(1).default(1),
      sourceId: z.string().trim().min(1).max(160).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ confirmed: _confirmed, ...input }) => jsonText(await saveConfirmedMemory({
    baseUrl: memoryBaseUrl,
    token: memoryToken,
    accessClientId: memoryAccessClientId,
    accessClientSecret: memoryAccessClientSecret,
    timeoutMs: memoryTimeoutMs,
  }, input)));
  return server;
}

function authorized(request: http.IncomingMessage): boolean {
  if (!authToken) return true;
  return request.headers.authorization === `Bearer ${authToken}`;
}

const server = http.createServer(async (request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(request.url === "/health" ? JSON.stringify({ ok: true }) : JSON.stringify({ error: "not_found" }));
    return;
  }
  if (!authorized(request)) {
    response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcp = createServer();
  await mcp.connect(transport);
  await transport.handleRequest(request, response, body);
});

server.listen(port, host, () => {
  console.log(`zxlab-bot-bridge listening on http://${host}:${port}/mcp`);
});
