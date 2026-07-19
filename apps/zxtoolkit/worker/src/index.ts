import { TransferSession } from "./session";
import { MAX_FILE_BYTES, SESSION_TTL_MS, validateUploadMetadata, type TransferRecord } from "./protocol";
import { hashToken, randomToken } from "./security";
import { PairingSession } from "./pairing";
import { DeviceMailbox } from "./device-mailbox";
import type { DevicePlatform, DropItem } from "../../shared/types";
import { validateDropPayload } from "../../shared/payload";
import { validatePulseSnapshot } from "../../shared/pulse";
import { PulseHub } from "./pulse-hub";
import { UploadQuota } from "./upload-quota";
import { BodyTooLargeError, declaredBodySize, hasImageSignature, readBodyWithLimit, readJsonWithLimit } from "./request-body";
import { verifyTurnstile } from "./turnstile";
import {
  authenticateDevice,
  completeImageTransfer,
  createPairingRecord,
  createTransfer,
  expireTransfers,
  failTransfer,
  getTransfer,
  inboxPage,
  listPairedDevices,
  migrateLegacyMailbox,
  recentTransfers,
  renameDevice,
  revokePairedDevice,
  rotateCredential,
  purgeExpiredRecords,
  updateTransferStatus,
  type AuthenticatedDevice
} from "./device-store";

export { TransferSession, PairingSession, DeviceMailbox, PulseHub, UploadQuota };

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
const TRANSFER_CONTENT_PATH = /^\/api\/transfers\/([a-f0-9-]+)\/content$/;
const TRANSFER_STATUS_PATH = /^\/api\/transfers\/([a-f0-9-]+)\/status$/;
const TRANSFER_DOWNLOAD_PATH = /^\/api\/transfers\/([a-f0-9-]+)\/download$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true }, 200, cors);
      if (request.method === "POST" && url.pathname === "/api/sessions") return createSession(request, env, cors);
      if (request.method === "POST" && url.pathname === "/api/pairing/sessions") return createPairing(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/devices") return listDevices(request, env, cors);
      if (request.method === "POST" && (url.pathname === "/api/drops" || url.pathname === "/api/transfers")) return createDrop(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/drops/recent") return recentDrops(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/inbox") return inbox(request, env, cors);
      if (request.method === "POST" && url.pathname === "/api/inbox/events/ticket") return createInboxEventTicket(request, env, cors);
      if (request.method === "GET" && url.pathname === "/api/inbox/events") return inboxEvents(request, env, cors);
      if (request.method === "POST" && url.pathname === "/api/devices/credential/rotate") return rotateDeviceCredential(request, env, cors);
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
      if (deviceMatch && request.method === "PATCH") return updateDevice(request, env, deviceMatch[1], cors);

      const dropOpenMatch = url.pathname.match(DROP_OPEN_PATH);
      if (dropOpenMatch && request.method === "POST") return markDropOpened(request, env, dropOpenMatch[1], cors);

      const transferContentMatch = url.pathname.match(TRANSFER_CONTENT_PATH);
      if (transferContentMatch && request.method === "POST") return uploadTransferContent(request, env, transferContentMatch[1], cors);

      const transferStatusMatch = url.pathname.match(TRANSFER_STATUS_PATH);
      if (transferStatusMatch && request.method === "PATCH") return updateDropStatus(request, env, transferStatusMatch[1], cors);

      const transferDownloadMatch = url.pathname.match(TRANSFER_DOWNLOAD_PATH);
      if (transferDownloadMatch && request.method === "GET") return downloadTransfer(request, env, transferDownloadMatch[1], cors);

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
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const expired = await expireTransfers(env.DB);
    const keys = expired.flatMap((item) => item.objectKey ? [item.objectKey] : []);
    await Promise.all(keys.map((key) => env.FILES.delete(key)));
    const retentionSeconds = positiveInteger(env.DROP_RECORD_RETENTION_SECONDS, 7 * 24 * 60 * 60);
    const purged = await purgeExpiredRecords(env.DB, new Date(Date.now() - retentionSeconds * 1000).toISOString());
    if (expired.length) console.log(JSON.stringify({ event: "expired_transfers_cleaned", count: expired.length, files: keys.length }));
    if (purged.transfers || purged.pairings) console.log(JSON.stringify({ event: "expired_records_purged", ...purged }));
  }
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env, cors: Headers): Promise<Response> {
  const source = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!(await env.SESSION_RATE_LIMITER.limit({ key: `session:${source}` })).success) {
    return problem("RATE_LIMITED", "创建会话过于频繁，请一分钟后再试", 429, cors);
  }
  const body = await safeJson(request);
  const verification = await verifyTurnstile(request, env, body?.turnstileToken);
  if (!verification.success) {
    const unavailable = verification.code === "unconfigured" || verification.code === "unavailable";
    return problem(
      unavailable ? "TURNSTILE_UNAVAILABLE" : "TURNSTILE_REQUIRED",
      unavailable ? "安全验证暂时不可用，请稍后重试" : "请先完成人机验证",
      unavailable ? 503 : 403,
      cors
    );
  }
  const id = crypto.randomUUID();
  const token = randomToken();
  const expiresAt = Date.now() + ttlMs(env);
  await env.SESSIONS.getByName(id).initialize(await hashToken(token), expiresAt);
  return json({ id, token, expiresAt }, 201, cors);
}

async function createPairing(request: Request, env: Env, cors: Headers): Promise<Response> {
  const source = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!(await env.SESSION_RATE_LIMITER.limit({ key: `pairing:${source}` })).success) {
    return problem("RATE_LIMITED", "创建配对过于频繁，请一分钟后再试", 429, cors);
  }
  const body = await safeJson(request);
  const desktopName = cleanName(body?.desktopName, "这台 Mac");
  const id = crypto.randomUUID();
  const claimToken = randomToken();
  const expiresAt = Date.now() + Math.min(Math.max(positiveInteger(env.PAIRING_TTL_SECONDS, 600), 60), 600) * 1000;
  const claimHash = await hashToken(claimToken);
  await createPairingRecord(env.DB, { id, claimHash, desktopName, expiresAt });
  await env.PAIRINGS.getByName(id).initialize(id, claimHash, desktopName, expiresAt);
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
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
  return json({ device: auth.device, pairedDevices: await listPairedDevices(env.DB, auth.device.id) }, 200, cors);
}

async function removeDevice(request: Request, env: Env, targetId: string, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  const removed = await revokePairedDevice(env.DB, auth.device.id, targetId);
  if (!removed) return problem("DEVICE_NOT_PAIRED", "目标设备未与当前设备绑定", 404, cors);
  await env.DEVICES.getByName(auth.device.id).removePairInternal(targetId).catch(() => undefined);
  await env.DEVICES.getByName(targetId).removePairInternal(auth.device.id).catch(() => undefined);
  await env.DEVICES.getByName(targetId).revokeInternal().catch(() => undefined);
  return json({ removed: true }, 200, cors);
}

async function updateDevice(request: Request, env: Env, targetId: string, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  if (targetId !== auth.device.id) return problem("DEVICE_FORBIDDEN", "只能修改当前设备名称", 403, cors);
  const body = await safeJson(request);
  const name = cleanName(body?.name, "");
  if (!name) return problem("INVALID_DEVICE_NAME", "请输入有效的设备名称", 400, cors);
  const device = await renameDevice(env.DB, targetId, name);
  return device ? json({ device }, 200, cors) : problem("DEVICE_UNAVAILABLE", "设备不存在或已被吊销", 404, cors);
}

async function rotateDeviceCredential(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  const token = randomToken();
  const version = await rotateCredential(env.DB, auth.device.id, await hashToken(token));
  if (!version) return problem("DEVICE_UNAVAILABLE", "设备不存在或已被吊销", 404, cors);
  return json({ credential: { device: { ...auth.device, credentialVersion: version }, token } }, 200, cors);
}

async function publishPulse(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
  const snapshot = validatePulseSnapshot(await safeJson(request));
  if (!snapshot) return problem("INVALID_PULSE", "公开状态快照无效、已过期或包含不支持字段", 400, cors);
  const published = await env.DEVICES.getByName(auth.device.id).publishPulseInternal(auth.device, snapshot);
  if (!published) return problem("DEVICE_UNAUTHORIZED", "设备无权发布 Pulse", 401, cors);
  await env.PULSE.getByName("public-status-v1").upsert(auth.device.id, published);
  return json({ accepted: true, snapshot }, 202, cors);
}

async function latestPulse(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
  return json({ snapshot: await env.DEVICES.getByName(auth.device.id).getPulseInternal() }, 200, cors);
}

async function publicStatus(env: Env, cors: Headers): Promise<Response> {
  const response = json(await env.PULSE.getByName("public-status-v1").publicStatus(), 200, cors);
  response.headers.set("cache-control", "public, max-age=30, stale-while-revalidate=60");
  return response;
}

async function createDrop(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  if (!(await env.UPLOAD_RATE_LIMITER.limit({ key: `drop:${auth.device.id}` })).success) {
    return problem("RATE_LIMITED", "投递过于频繁，请稍后重试", 429, cors);
  }
  const body = await safeJson(request);
  const receiverDeviceId = typeof body?.receiverDeviceId === "string" ? body.receiverDeviceId : "";
  const payload = validateDropPayload(body?.payload);
  if (!receiverDeviceId || !payload) return problem("INVALID_DROP", "投递内容或目标设备无效", 400, cors);
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const used = await env.DB.prepare("SELECT COUNT(*) AS count FROM transfers WHERE sender_device_id = ?1 AND created_at >= ?2").bind(auth.device.id, startOfDay.toISOString()).first<{ count: number }>();
  if ((used?.count ?? 0) >= positiveInteger(env.DAILY_DROP_LIMIT, 200)) return problem("DAILY_QUOTA_EXCEEDED", "今日投递次数已用完，请明天再试", 429, cors);
  const item = await createTransfer(env.DB, auth.device, receiverDeviceId, payload, positiveInteger(env.DROP_TTL_SECONDS, 86400) * 1000);
  if (!item) return problem("DROP_FORBIDDEN", "目标设备未与当前设备绑定或已被吊销", 403, cors);
  if (item.status === "delivered") await env.DEVICES.getByName(receiverDeviceId).notifyInbox(item);
  return json({ item }, 201, cors);
}

async function inbox(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
  const url = new URL(request.url);
  const page = await inboxPage(env.DB, auth.device.id, url.searchParams.get("cursor"), Number(url.searchParams.get("limit")));
  return json(page, 200, cors);
}

async function recentDrops(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
  return json({ items: await recentTransfers(env.DB, auth.device.id) }, 200, cors);
}

async function markDropOpened(request: Request, env: Env, dropId: string, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  const transfer = await updateTransferStatus(env.DB, dropId, auth.device.id, "opened");
  if (!transfer) return problem("DROP_UNAVAILABLE", "投递内容不存在、无权访问或已过期", 404, cors);
  return json({ opened: true }, 200, cors);
}

async function inboxEvents(request: Request, env: Env, cors: Headers): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return problem("UPGRADE_REQUIRED", "请使用 WebSocket 连接收件箱", 426, cors);
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("deviceId") ?? "";
  if (!/^[a-f0-9-]{36}$/.test(deviceId) || !url.searchParams.get("ticket")) return problem("SOCKET_UNAUTHORIZED", "实时连接凭证无效", 401, cors);
  return env.DEVICES.getByName(deviceId).fetch(request);
}

async function createInboxEventTicket(request: Request, env: Env, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效或已被吊销", 401, cors);
  const ticket = randomToken(24);
  const expiresAt = Date.now() + 60_000;
  await env.DEVICES.getByName(auth.device.id).issueSocketTicket(await hashToken(ticket), expiresAt);
  return json({ deviceId: auth.device.id, ticket, expiresAt }, 201, cors);
}

async function uploadTransferContent(request: Request, env: Env, transferId: string, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  if (!(await env.UPLOAD_RATE_LIMITER.limit({ key: `transfer-content:${auth.device.id}` })).success) return problem("RATE_LIMITED", "上传过于频繁，请稍后重试", 429, cors);

  const stored = await getTransfer(env.DB, transferId);
  if (!stored || stored.item.senderDeviceId !== auth.device.id || stored.item.payload.type !== "image") return problem("TRANSFER_UNAVAILABLE", "图片投递不存在或无权上传", 404, cors);
  if (stored.item.status !== "pending" || Date.parse(stored.item.expiresAt) <= Date.now()) return problem("TRANSFER_UNAVAILABLE", "图片投递已完成或已过期", 409, cors);
  const mimeType = request.headers.get("content-type")?.split(";")[0] ?? "";
  const declaredSize = declaredBodySize(request.headers.get("content-length"));
  const maxBytes = Math.min(MAX_FILE_BYTES, positiveInteger(env.MAX_FILE_BYTES, MAX_FILE_BYTES));
  const metadataError = validateUploadMetadata(mimeType, declaredSize, maxBytes);
  if (metadataError || mimeType !== stored.item.payload.mimeType) return problem("INVALID_FILE", metadataError || "图片类型与投递信息不一致", 400, cors);
  if (!request.body) return problem("EMPTY_FILE", "没有读取到图片内容", 400, cors);

  const now = new Date();
  const quotaKey = now.toISOString().slice(0, 10);
  const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const quota = env.UPLOAD_QUOTAS.getByName(`upload-${quotaKey}`);
  const reservation = await quota.reserve(maxBytes, positiveInteger(env.DAILY_UPLOAD_LIMIT, 500), positiveInteger(env.DAILY_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024), resetAt);
  if (!reservation.accepted) return problem("DAILY_QUOTA_EXCEEDED", reservation.reason === "bytes" ? "今日传输容量已用完，请明天再试" : "今日上传次数已用完，请明天再试", 429, cors);

  const objectKey = `drops/${auth.device.id}/${randomToken(18)}`;
  let body: Uint8Array;
  let item: DropItem;
  try {
    body = await readBodyWithLimit(request.body, maxBytes);
    if (!body.byteLength) throw new Error("EMPTY_FILE");
    if (!hasImageSignature(body, mimeType)) {
      await quota.rollback(maxBytes);
      await failTransfer(env.DB, transferId, auth.device.id, "INVALID_FILE_SIGNATURE");
      return problem("INVALID_FILE_SIGNATURE", "图片内容与文件类型不匹配", 400, cors);
    }
    await env.FILES.put(objectKey, body, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { transferId, senderDeviceId: auth.device.id, receiverDeviceId: stored.item.receiverDeviceId }
    });
    const completedItem = await completeImageTransfer(env.DB, transferId, auth.device.id, objectKey, body.byteLength);
    if (!completedItem) {
      await env.FILES.delete(objectKey);
      await quota.rollback(maxBytes);
      return problem("TRANSFER_UNAVAILABLE", "投递已失效，请重新发送", 409, cors);
    }
    item = completedItem;
  } catch (cause) {
    await env.FILES.delete(objectKey);
    await quota.rollback(maxBytes);
    await failTransfer(env.DB, transferId, auth.device.id, cause instanceof BodyTooLargeError ? "FILE_TOO_LARGE" : "UPLOAD_FAILED");
    if (cause instanceof BodyTooLargeError) return problem("FILE_TOO_LARGE", "单张图片不能超过 20 MB", 413, cors);
    if (cause instanceof Error && cause.message === "EMPTY_FILE") return problem("EMPTY_FILE", "图片内容为空", 400, cors);
    throw cause;
  }
  await quota.commit(maxBytes, body.byteLength).catch((error) => {
    console.error(JSON.stringify({ event: "upload_quota_commit_failed", transferId, error: error instanceof Error ? error.message : "unknown" }));
  });
  await env.DEVICES.getByName(item.receiverDeviceId).notifyInbox(item).catch((error) => {
    console.error(JSON.stringify({ event: "inbox_notification_failed", transferId, error: error instanceof Error ? error.message : "unknown" }));
  });
  return json({ item }, 201, cors);
}

async function downloadTransfer(request: Request, env: Env, transferId: string, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  if (!(await env.DOWNLOAD_RATE_LIMITER.limit({ key: `transfer-download:${auth.device.id}` })).success) return problem("RATE_LIMITED", "下载过于频繁，请稍后重试", 429, cors);
  const stored = await getTransfer(env.DB, transferId);
  if (!stored || stored.item.receiverDeviceId !== auth.device.id || stored.item.payload.type !== "image") return problem("TRANSFER_UNAVAILABLE", "图片不存在或无权访问", 404, cors);
  if (!stored.objectKey || stored.item.status === "claimed" || stored.item.status === "expired" || Date.parse(stored.item.expiresAt) <= Date.now()) return problem("FILE_UNAVAILABLE", "图片已领取或已过期", 410, cors);
  const object = await env.FILES.get(stored.objectKey);
  if (!object?.body) return problem("FILE_MISSING", "临时图片已被清理", 410, cors);
  const headers = new Headers(cors);
  object.writeHttpMetadata(headers);
  headers.set("content-type", stored.item.payload.mimeType);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "private, no-store");
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(stored.item.payload.fileName)}`);
  return new Response(object.body, { headers });
}

async function updateDropStatus(request: Request, env: Env, transferId: string, cors: Headers): Promise<Response> {
  const auth = await authorizeDevice(request, env);
  if (!auth) return problem("DEVICE_UNAUTHORIZED", "设备凭证无效", 401, cors);
  const body = await safeJson(request);
  const status = body?.status === "opened" || body?.status === "claimed" ? body.status : null;
  if (!status) return problem("INVALID_STATUS", "不支持的投递状态", 400, cors);
  const updated = await updateTransferStatus(env.DB, transferId, auth.device.id, status);
  if (!updated) return problem("TRANSFER_UNAVAILABLE", "投递不存在、无权操作或状态无效", 404, cors);
  if (status === "claimed" && updated.objectKey) await env.FILES.delete(updated.objectKey);
  return json({ item: updated.item }, 200, cors);
}

async function uploadFile(request: Request, env: Env, sessionId: string, cors: Headers): Promise<Response> {
  if (!(await env.UPLOAD_RATE_LIMITER.limit({ key: `upload:${sessionId}` })).success) {
    return problem("RATE_LIMITED", "上传过于频繁，请稍后重试", 429, cors);
  }
  const token = requestToken(request, new URL(request.url));
  const declaredSize = declaredBodySize(request.headers.get("content-length"));
  const mimeType = request.headers.get("content-type")?.split(";")[0] ?? "";
  const maxBytes = Math.min(MAX_FILE_BYTES, positiveInteger(env.MAX_FILE_BYTES, MAX_FILE_BYTES));
  const error = validateUploadMetadata(mimeType, declaredSize, maxBytes);
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
    size: 0,
    status: "uploading",
    createdAt: Date.now(),
    expiresAt: session.expiresAt
  };

  if (!(await stub.beginTransfer(token, transfer))) {
    return problem("TRANSFER_REJECTED", "当前会话暂时无法接收新文件", 409, cors);
  }

  const now = new Date();
  const quotaKey = now.toISOString().slice(0, 10);
  const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const quota = env.UPLOAD_QUOTAS.getByName(`upload-${quotaKey}`);
  const reservation = await quota.reserve(
    maxBytes,
    positiveInteger(env.DAILY_UPLOAD_LIMIT, 500),
    positiveInteger(env.DAILY_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024),
    resetAt
  );
  if (!reservation.accepted) {
    await stub.failTransfer(token, transferId);
    return problem("DAILY_QUOTA_EXCEEDED", reservation.reason === "bytes" ? "今日传输容量已用完，请明天再试" : "今日上传次数已用完，请明天再试", 429, cors);
  }

  let body: Uint8Array;
  let completed: TransferRecord;
  try {
    body = await readBodyWithLimit(request.body, maxBytes);
    if (!body.byteLength) throw new Error("EMPTY_FILE");
    if (!hasImageSignature(body, mimeType)) {
      await quota.rollback(maxBytes);
      await stub.failTransfer(token, transferId);
      return problem("INVALID_FILE_SIGNATURE", "图片内容与文件类型不匹配", 400, cors);
    }
    await env.FILES.put(objectKey, body, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { fileName, sessionId, transferId }
    });
    const result = await stub.completeTransfer(token, transferId, body.byteLength);
    if (!result) {
      await env.FILES.delete(objectKey);
      await quota.rollback(maxBytes);
      return problem("TRANSFER_REJECTED", "会话已失效，请创建新会话", 409, cors);
    }
    completed = result;
  } catch (cause) {
    await env.FILES.delete(objectKey);
    await quota.rollback(maxBytes);
    await stub.failTransfer(token, transferId);
    if (cause instanceof BodyTooLargeError) return problem("FILE_TOO_LARGE", "单个文件不能超过 20 MB", 413, cors);
    if (cause instanceof Error && cause.message === "EMPTY_FILE") return problem("EMPTY_FILE", "文件为空", 400, cors);
    throw cause;
  }
  await quota.commit(maxBytes, body.byteLength).catch((error) => {
    console.error(JSON.stringify({ event: "upload_quota_commit_failed", transferId, error: error instanceof Error ? error.message : "unknown" }));
  });
  return json({ transfer: completed }, 201, cors);
}

async function downloadFile(request: Request, env: Env, sessionId: string, transferId: string, cors: Headers): Promise<Response> {
  if (!(await env.DOWNLOAD_RATE_LIMITER.limit({ key: `download:${sessionId}` })).success) {
    return problem("RATE_LIMITED", "下载过于频繁，请稍后重试", 429, cors);
  }
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

async function authorizeDevice(request: Request, env: Env): Promise<AuthenticatedDevice | null> {
  const auth = deviceAuth(request);
  if (!auth) return null;
  const current = await authenticateDevice(env.DB, auth.deviceId, auth.token).catch(() => null);
  if (current) return current;

  const legacy = await env.DEVICES.getByName(auth.deviceId).listDevices(auth.token).catch(() => null);
  if (!legacy) return null;
  const tokenHash = await hashToken(auth.token);
  await migrateLegacyMailbox(env.DB, legacy.device, tokenHash, legacy.pairedDevices);
  return { device: legacy.device, tokenHash };
}

async function safeJson(request: Request): Promise<Record<string, unknown> | null> {
  return readJsonWithLimit(request);
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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("origin") ?? "";
  const allowed = new Set([env.APP_ORIGIN, env.ZXLAB_ORIGIN, "http://localhost:4173", "http://127.0.0.1:4173", "http://localhost:4174", "http://localhost:4321", "http://tauri.localhost", "tauri://localhost"]);
  const headers = new Headers({
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,content-length,x-file-name,x-device-id",
    "access-control-expose-headers": "content-length,content-type,content-disposition,x-request-id",
    "x-request-id": crypto.randomUUID(),
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
