import "dotenv/config";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { formatLatestSignal } from "./format.js";
import { fetchLatestSignal } from "./signal.js";

const host = process.env.BRIDGE_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT || "8789");
const signalBaseUrl = process.env.SIGNAL_API_BASE_URL?.trim() || "https://signal-api.zx-dx.xyz";
const authToken = process.env.BRIDGE_AUTH_TOKEN?.trim();
const timeoutMs = Number(process.env.SIGNAL_REQUEST_TIMEOUT_MS || "15000");

function createServer(): McpServer {
  const server = new McpServer({ name: "zxlab-bot-bridge", version: "0.1.0" });
  server.registerTool("signal_latest", {
    title: "Latest ZX Signal",
    description: "Read the latest published ZX Signal briefing and format it for a private chat.",
    inputSchema: { detail: z.enum(["full", "summary"]).default("full") },
  }, async ({ detail }) => {
    const briefing = await fetchLatestSignal({ baseUrl: signalBaseUrl, timeoutMs });
    const text = detail === "summary" ? `${briefing.title}\n\n${briefing.summary}` : formatLatestSignal(briefing);
    return { content: [{ type: "text", text }] };
  });
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
