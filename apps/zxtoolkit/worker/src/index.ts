import { TransferSession } from "./session";
import { MAX_FILE_BYTES, SESSION_TTL_MS, validateUpload, type TransferRecord } from "./protocol";
import { hashToken, randomToken } from "./security";
import { PairingSession } from "./pairing";
import { DeviceMailbox } from "./device-mailbox";
import type { DevicePlatform } from "../../shared/types";
import { validateDropPayload } from "../../shared/payload";
import { validatePulseSnapshot } from "../../shared/pulse";
import { PulseHub } from "./pulse-hub";

export { TransferSession, PairingSession, DeviceMailbox, PulseHub };

const SESSION_PATH = /^\/api\/sessions\/([a-f0-9-]+)$/;
const UPLOAD_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/upload$/;
const SOCKET_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/socket$/;
const FILE_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/files\/([a-f0-9-]+)$/;
const CLAIM_PATH = /^\/api\/sessions\/([a-f0-9-]+)\/files\/([a-f0-9-]+)\/claim$/;
const PAIRING_PATH = /^\/api\/pairing\/sessions\/([a-f0-9-]+)$/;
const PAIRING_CONFIRM_PATH = /^\/api\/pairing\/sessions\/([a-f0-9-]+)\/confirm$/;
const PAIRING_CANCEL_PATH = /^\/api\/pairing\/sessions\/([a-f0-9-]+)\/cancel$/;
const DEVICE_PATH = /^\/api\/devices\/([a-f0-9-]+)$/;
const DROP_OPEN_PATH = /^\/api\/drops\/([a-f0-9-]+)\/opened$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true }, 200, cors);
      if (request.method === "POST" && url.pathname === "/api/sessions") return createSession(env, cors);
      if (request.method === "POST" && url.pathname === "/api/pairing/sessions") return createPairing(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/devices") return listDevices(request, env, cors);
      if (request.method === "POST" && url.pathname === "/api/drops") return createDrop(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/drops/recent") return recentDrops(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/inbox") return inbox(request, env, cors);
      if (request.method === "POST" && url.pathname === "/api/pulse/snapshots") return publishPulse(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/pulse/snapshots/latest") return latestPulse(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/pulse/devices") return listDevices(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/public/status") return publicStatus(env, cors);

      const pairingCancelMatch = url.pathname.match(PAIRING_CANCEL_PATH);
      if (pairingCancelMatch && request.method === "POST") return cancelPairing(request, env, pairingCancelMatch[1], cors);

      const pairingConfirmMatch = url.pathname.match(PAIRING_CONFIRM_PATH);
      if (pairingConfirmMatch && request.method === "POST") return confirmPairing(request, env, pairingConfirmMatch[1], cors);

      const pairingMatch = url.pathname.match(PAIRING_PATH);
      if (pairingMatch && request.method === "GET") return pairingStatus(request, env, pairingMatch[1], cors);

      const deviceMatch = url.pathname.match(DEVICE_PATH);
      if (deviceMatch && request.method === "DELETE") return removeDevice(request, env, deviceMatch[1], cors);

      const dropOpenMatch = url.pathname.match(DROP_OPEN_PATH);
      if (dropOpenMatch && request.method === "POST") return markDropOpened(request, env, dropOpenMatch[1], cors);

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

async function createPairing(request: Request, env: Env, cors: Headers): Promise<Response> {
  const body = await safeJson(request);
  const desktopName = cleanName(body?.desktopName, "这台 Mac");
  const id = crypto.randomUUID();
  const claimToken = randomToken();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await env.PAIRINGS.getByName(id).initialize(await hashToken(claimToken), desktopName, expiresAt);
  return json({
    id,
    claimToken,
    pairUrl: `${env.APP_ORIGIN.replace(/\/$/, "")}/pair/${id}`,
    expiresAt: new Date(expiresAt).toISOString()
  }, 201, cors);
}

async function pairingStatus(request: Request, env: Env, pairingId: string, cors: Headers): Promise<Response> {
  const status = await env.PAIRINGS.getByName(pairingId).status(requestToken(request, new URL(request.url)));
  return status ? json(status, 200, cors) : problem("PAIRING_UNAUTHORIZED", "配对会话无效或无权访问", 401, cors);
}

async function confirmPairing(request: Request, env: Env, pairingId: string, cors: Headers): Promise<Response> {
  const body = await safeJson(request);
  const name = cleanName(body?.name, "我的手机");
  const platform = devicePlatform(body?.platform ?? body?.type);
  const credential = await env.PAIRINGS.getByName(pairingId).confirm(name, platform);
  return credential ? json({ credential }, 201, cors) : problem("PAIRING_UNAVAILABLE", "配对码已使用或已过期", 409, cors);
}

async function cancelPairing(request: Request, env: Env, pairingId: string, cors: Headers): Promise<Response> {
  const cancelled = await env.PAIRINGS.getByName(pairingId).cancel(requestToken(request, new URL(request.url)));
  return cancelled ? json({ cancelled: true }, 200, cors) : problem("PAIRING_UNAVAILABLE", "配对会话无效或已结束", 409, cors);
}

async function listDevices(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const result = await env.DEVICES.getByName(auth.deviceId).listDevices(auth.token);
  return result ? json(result, 200, cors) : problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
}

async function removeDevice(request: Request, env: Env, targetId: string, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const removed = await env.DEVICES.getByName(auth.deviceId).removePair(auth.token, targetId);
  if (!removed) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  await env.DEVICES.getByName(targetId).removePairInternal(auth.deviceId);
  await env.DEVICES.getByName(targetId).revokeInternal();
  return json({ removed: true }, 200, cors);
}

async function publishPulse(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const snapshot = validatePulseSnapshot(await safeJson(request));
  if (!snapshot) return problem("INVALID_PULSE", "公开状态快照无效、已过期或包含不支持字段", 400, cors);
  const published = await env.DEVICES.getByName(auth.deviceId).publishPulse(auth.token, snapshot);
  if (!published) return problem("DEVICE_UNAUTHORIZED", "设备无权发布 Pulse", 401, cors);
  await env.PULSE.getByName("public-status-v1").upsert(auth.deviceId, published);
  return json({ accepted: true, snapshot }, 202, cors);
}

async function latestPulse(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const snapshot = await env.DEVICES.getByName(auth.deviceId).getPulse(auth.token);
  return snapshot === false ? problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors) : json({ snapshot }, 200, cors);
}

async function publicStatus(env: Env, cors: Headers): Promise<Response> {
  const response = json(await env.PULSE.getByName("public-status-v1").publicStatus(), 200, cors);
  response.headers.set("cache-control", "public, max-age=30, stale-while-revalidate=60");
  return response;
}

async function createDrop(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const body = await safeJson(request);
  const receiverDeviceId = typeof body?.receiverDeviceId === "string" ? body.receiverDeviceId : "";
  const payload = validateDropPayload(body?.payload);
  if (!receiverDeviceId || !payload) return problem("INVALID_DROP", "投递内容或目标设备无效", 400, cors);
  const prepared = await env.DEVICES.getByName(auth.deviceId).prepareDrop(auth.token, receiverDeviceId, payload);
  if (!prepared) return problem("DROP_FORBIDDEN", "目标设备未与当前设备绑定", 403, cors);
  const delivered = await env.DEVICES.getByName(receiverDeviceId).receiveDrop(prepared.sender, prepared.item);
  if (!delivered) return problem("RECEIVER_UNAVAILABLE", "目标设备已解除绑定", 409, cors);
  await env.DEVICES.getByName(auth.deviceId).markStatus(prepared.item.id, "delivered");
  return json({ item: { ...prepared.item, status: "delivered" } }, 201, cors);
}

async function inbox(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const items = await env.DEVICES.getByName(auth.deviceId).getInbox(auth.token);
  return items ? json({ items }, 200, cors) : problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
}

async function recentDrops(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const items = await env.DEVICES.getByName(auth.deviceId).getRecent(auth.token);
  return items ? json({ items }, 200, cors) : problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
}

async function markDropOpened(request: Request, env: Env, dropId: string, cors: Headers): Promise<Response> {
  const auth = deviceAuth(request);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证缺失", 401, cors);
  const item = await env.DEVICES.getByName(auth.deviceId).markOpened(auth.token, dropId);
  if (!item) return problem("DROP_UNAVAILABLE", "投递内容不存在或已过期", 404, cors);
  await env.DEVICES.getByName(item.senderDeviceId).markStatus(item.id, "opened");
  return json({ opened: true }, 200, cors);
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

function deviceAuth(request: Request): { deviceId: string; token: string } | null {
  const deviceId = request.headers.get("x-device-id") ?? "";
  const token = requestToken(request, new URL(request.url));
  return deviceId && token ? { deviceId, token } : null;
}

async function safeJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 64 * 1024) return null;
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}

function cleanName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 48) : fallback;
}

function devicePlatform(value: unknown): DevicePlatform {
  if (value === "macos" || value === "android" || value === "ios" || value === "windows" || value === "linux" || value === "web") return value;
  return value === "mac" ? "macos" : value === "phone" ? "android" : value === "tablet" ? "ios" : "web";
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
  const allowed = new Set([env.APP_ORIGIN, env.ZXLAB_ORIGIN, "http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:4174", "http://localhost:4321", "http://tauri.localhost", "tauri://localhost"]);
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,content-length,x-file-name,x-device-id",
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
