import { TransferSession } from "./session";
import { MAX_FILE_BYTES, SESSION_TTL_MS, validateUpload, type TransferRecord } from "./protocol";
import { hashToken, randomToken } from "./security";

export { TransferSession };

const SESSION_PATH = /^\/api\/sessions\/([a-f0-9-]+)$/;
const UPLOAD_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/upload$/;
const SOCKET_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/socket$/;
const FILE_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/files\/([a-f0-9-]+)$/;
const CLAIM_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/files\/([a-f0-9-]+)\/claim$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true }, 200, cors);
      if (request.method === "POST" && url.pathname === "/api/sessions") return createSession(env, cors);

      const socketMatch = url.pathname.match(SOCKET_PATH);
      if (socketMatch && request.method === "GET") {
        return env.SESSIONS.getByName(socketMatch[1]).fetch(request);
      }

      const sessionMatch = url.pathname.match(SESSION_PATH);
      if (sessionMatch && request.method === "GET") {
        const token = requestToken(request, url);
        const state = await env.SESSIONS.getByName(sessionMatch[1]).inspect(token);
        return state ? json(state, 200, cors) : problem("SESSION_UNAVAILABLE", "会话无效或已过期", 401, cors);
      }

      const uploadMatch = url.pathname.match(UPLOAD_PATH);
      if (uploadMatch && request.method === "POST") return uploadFile(request, env, uploadMatch[1], cors);

      const claimMatch = url.pathname.match(CLAIM_PATH);
      if (claimMatch && request.method === "POST") return claimFile(request, env, claimMatch[1], claimMatch[2], cors);

      const fileMatch = url.pathname.match(FILE_PATH);
      if (fileMatch && request.method === "GET") return downloadFile(request, env, fileMatch[1], fileMatch[2], cors);
      if (fileMatch && request.method === "DELETE") return deleteFile(request, env, fileMatch[1], fileMatch[2], cors);

      return problem("NOT_FOUND", "没有找到这个传输入口", 404, cors);
    } catch (error) {
      console.error(JSON.stringify({ event: "request_failed", path: url.pathname, error: error instanceof Error ? error.message : "unknown" }));
      return problem("INTERNAL_ERROR", "服务暂时不可用，请稍后重试", 500, cors);
    }
  }
} satisfies ExportedHandler<Env>;

async function createSession(env: Env, cors: Headers): Promise<Response> {
  const id = crypto.randomUUID();
  const token = randomToken();
  const expiresAt = Date.now() + ttlMs(env);
  await env.SESSIONS.getByName(id).initialize(await hashToken(token), expiresAt);
  return json({ id, token, expiresAt }, 201, cors);
}

async function uploadFile(request: Request, env: Env, sessionId: string, cors: Headers): Promise<Response> {
  const token = requestToken(request, new URL(request.url));
  const length = Number(request.headers.get("content-length"));
  const mimeType = request.headers.get("content-type")?.split(";")[0] ?? "";
  const error = validateUpload(mimeType, length, Number(env.MAX_FILE_BYTES || MAX_FILE_BYTES));
  if (error) return problem("INVALID_FILE", error, 400, cors);
  if (!request.body) return problem("EMPTY_FILE", "没有读取到图片内容", 400, cors);

  const stub = env.SESSIONS.getByName(sessionId);
  const session = await stub.inspect(token);
  if (!session) return problem("SESSION_UNAVAILABLE", "会话无效或已过期", 401, cors);
  if (!session.receiverOnline) return problem("RECEIVER_OFFLINE", "手机尚未连接，请扫码并保持页面打开", 409, cors);

  const transferId = crypto.randomUUID();
  const objectKey = `${sessionId}/${transferId}`;
  const rawName = request.headers.get("x-file-name") ?? "image";
  const fileName = safeFileName(rawName);
  const transfer: TransferRecord = {
    id: transferId,
    objectKey,
    fileName,
    mimeType,
    size: length,
    status: "ready",
    createdAt: Date.now(),
    expiresAt: session.expiresAt
  };

  await env.FILES.put(objectKey, request.body, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { fileName, sessionId, transferId }
  });
  const registered = await stub.registerTransfer(token, transfer);
  if (!registered) {
    await env.FILES.delete(objectKey);
    return problem("TRANSFER_REJECTED", "当前会话暂时无法接收新文件", 409, cors);
  }
  return json({ transfer }, 201, cors);
}

async function downloadFile(request: Request, env: Env, sessionId: string, transferId: string, cors: Headers): Promise<Response> {
  const token = requestToken(request, new URL(request.url));
  const transfer = await env.SESSIONS.getByName(sessionId).getTransfer(token, transferId);
  if (!transfer) return problem("FILE_UNAVAILABLE", "文件已过期、已领取或已删除", 404, cors);
  const object = await env.FILES.get(transfer.objectKey);
  if (!object?.body) return problem("FILE_MISSING", "临时文件已被清理", 410, cors);
  const headers = new Headers(cors);
  object.writeHttpMetadata(headers);
  headers.set("content-type", transfer.mimeType);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "private, no-store");
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(transfer.fileName)}`);
  return new Response(object.body, { headers });
}

async function claimFile(request: Request, env: Env, sessionId: string, transferId: string, cors: Headers): Promise<Response> {
  const token = requestToken(request, new URL(request.url));
  const stub = env.SESSIONS.getByName(sessionId);
  const transfer = await stub.claimTransfer(token, transferId);
  if (!transfer) return problem("ALREADY_CLAIMED", "文件已被领取或不可用", 409, cors);
  await env.FILES.delete(transfer.objectKey);
  return json({ deleted: true }, 200, cors);
}

async function deleteFile(request: Request, env: Env, sessionId: string, transferId: string, cors: Headers): Promise<Response> {
  const token = requestToken(request, new URL(request.url));
  const transfer = await env.SESSIONS.getByName(sessionId).deleteTransfer(token, transferId);
  if (!transfer) return problem("FILE_UNAVAILABLE", "文件已经被删除", 404, cors);
  await env.FILES.delete(transfer.objectKey);
  return json({ deleted: true }, 200, cors);
}

function requestToken(request: Request, url: URL): string {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return url.searchParams.get("token") ?? "";
}

function safeFileName(value: string): string {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { decoded = "image"; }
  return decoded.replace(/[\\/\0\r\n]/g, "_").slice(0, 180) || "image";
}

function ttlMs(env: Env): number {
  const seconds = Number(env.SESSION_TTL_SECONDS || SESSION_TTL_MS / 1000);
  return Math.min(Math.max(seconds, 60), 600) * 1000;
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("origin") ?? "";
  const allowed = new Set([env.APP_ORIGIN, "http://localhost:4173", "http://127.0.0.1:4173"]);
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,content-length,x-file-name",
    "access-control-expose-headers": "content-length,content-type,content-disposition",
    "vary": "Origin"
  });
  if (allowed.has(origin)) headers.set("access-control-allow-origin", origin);
  return headers;
}

function json(value: unknown, status: number, headers: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return Response.json(value, { status, headers: responseHeaders });
}

function problem(code: string, message: string, status: number, headers: Headers): Response {
  return json({ error: { code, message } }, status, headers);
}
