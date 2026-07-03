import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AppServerClient, AppServerError } from "./lib/app-server-client.mjs";
import { errorResponse, normalizeUsage } from "./lib/normalize.mjs";

const config = {
  host: process.env.COLLECTOR_HOST || "127.0.0.1",
  port: Number(process.env.COLLECTOR_PORT || 8788),
  token: process.env.STATUS_API_TOKEN || "",
  command: process.env.CODEX_BIN || "codex",
  cacheTtlMs: Number(process.env.COLLECTOR_CACHE_TTL || 120) * 1000,
  staleTtlMs: Number(process.env.COLLECTOR_STALE_TTL || 21600) * 1000,
  timeoutMs: Number(process.env.CODEX_REQUEST_TIMEOUT || 8) * 1000,
};

if (!config.token) throw new Error("STATUS_API_TOKEN is required");

const client = new AppServerClient({ command: config.command, timeoutMs: config.timeoutMs });
let cache = null;
let refreshPromise = null;
let lastSuccessAt = null;

function authorized(request) {
  const value = request.headers.authorization || "";
  const expected = `Bearer ${config.token}`;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await client.start();
    const raw = await client.readUsage();
    const data = normalizeUsage(raw.rateLimits, raw.usage);
    cache = { data, collectedAt: Date.now() };
    lastSuccessAt = data.updatedAt;
    return data;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function usage() {
  const age = cache ? Date.now() - cache.collectedAt : Infinity;
  if (age <= config.cacheTtlMs) return cache.data;
  try { return await refresh(); } catch (error) {
    if (cache && age <= config.staleTtlMs) return { ...cache.data, status: "stale" };
    const code = error instanceof AppServerError ? error.code : "UPSTREAM_ERROR";
    const publicMessage = {
      CODEX_NOT_LOGGED_IN: "Codex is not logged in on the collector host.",
      METHOD_UNSUPPORTED: "The installed Codex version does not support the required usage method.",
      REQUEST_TIMEOUT: "Codex App Server did not respond in time.",
      APP_SERVER_UNAVAILABLE: "Codex App Server is unavailable.",
    }[code] || "Codex usage could not be collected.";
    return errorResponse(code, publicMessage, code === "APP_SERVER_UNAVAILABLE" ? "offline" : "error");
  }
}

function send(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

client.on("rate-limits-updated", () => {
  if (cache && Date.now() - cache.collectedAt > 15000) void refresh().catch(() => {});
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" });
  if (url.pathname === "/health") {
    return send(response, 200, {
      status: client.child ? "online" : "starting",
      version: "1.0.0",
      appServer: client.child ? "online" : "unknown",
      lastSuccessAt,
    });
  }
  if (url.pathname !== "/v1/usage") return send(response, 404, { error: "not_found" });
  if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
  const payload = await usage();
  send(response, payload.status === "error" || payload.status === "offline" ? 503 : 200, payload);
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`Codex usage collector listening on ${config.host}:${config.port}\n`);
  void refresh().catch(() => {});
});

async function shutdown() {
  server.close();
  await client.stop();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
