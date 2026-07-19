import type { Device, DropItem, DropPayload, DropStatus, InboxPage } from "../../shared/types";
import { canAdvanceDropStatus } from "../../shared/payload";
import { constantTimeEqual, hashToken } from "./security";

export const DROP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INBOX_LIMIT = 30;
export const MAX_INBOX_LIMIT = 50;

interface DeviceRow {
  id: string;
  name: string;
  platform: Device["platform"];
  capabilities: string;
  created_at: string;
  last_seen_at: string | null;
  credential_version: number;
  revoked_at: string | null;
}

interface CredentialRow extends DeviceRow {
  token_hash: string;
  credential_status: "active" | "revoked";
}

interface TransferRow {
  id: string;
  sender_device_id: string;
  sender_name: string;
  receiver_device_id: string;
  type: "text" | "url" | "image";
  text_content: string | null;
  url: string | null;
  title: string | null;
  file_name: string | null;
  mime_type: string | null;
  size: number;
  object_key: string | null;
  status: DropStatus;
  failure_code: string | null;
  created_at: string;
  expires_at: string;
  status_updated_at: string;
}

export interface AuthenticatedDevice {
  device: Device;
  tokenHash: string;
}

export interface StoredTransfer {
  item: DropItem;
  objectKey: string | null;
}

export async function authenticateDevice(db: D1Database, deviceId: string, token: string): Promise<AuthenticatedDevice | null> {
  if (!deviceId || !token) return null;
  const row = await db.prepare(`
    SELECT d.*, c.token_hash, c.status AS credential_status
    FROM devices d
    JOIN device_credentials c ON c.device_id = d.id
    WHERE d.id = ?1
  `).bind(deviceId).first<CredentialRow>();
  if (!row || row.revoked_at || row.credential_status !== "active") return null;
  const providedHash = await hashToken(token);
  if (!constantTimeEqual(providedHash, row.token_hash)) return null;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE devices SET last_seen_at = ?1 WHERE id = ?2").bind(now, deviceId),
    db.prepare("UPDATE device_credentials SET last_used_at = ?1 WHERE device_id = ?2").bind(now, deviceId)
  ]);
  return { device: deviceFromRow(row), tokenHash: row.token_hash };
}

export async function createDevicePair(
  db: D1Database,
  desktop: Device,
  desktopTokenHash: string,
  receiver: Device,
  receiverTokenHash: string,
  pairingId: string
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    insertDevice(db, desktop),
    insertCredential(db, desktop.id, desktopTokenHash, desktop.credentialVersion, now),
    insertDevice(db, receiver),
    insertCredential(db, receiver.id, receiverTokenHash, receiver.credentialVersion, now),
    db.prepare("INSERT INTO device_links (device_id, paired_device_id, created_at) VALUES (?1, ?2, ?3)").bind(desktop.id, receiver.id, now),
    db.prepare("INSERT INTO device_links (device_id, paired_device_id, created_at) VALUES (?1, ?2, ?3)").bind(receiver.id, desktop.id, now),
    db.prepare(`UPDATE pairing_sessions SET status = 'confirmed', desktop_device_id = ?1, receiver_device_id = ?2, completed_at = ?3 WHERE id = ?4 AND status = 'confirming'`).bind(desktop.id, receiver.id, now, pairingId)
  ]);
}

export async function migrateLegacyMailbox(db: D1Database, device: Device, tokenHash: string, pairedDevices: Device[]): Promise<void> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    upsertDevice(db, device),
    db.prepare(`
      INSERT INTO device_credentials (device_id, token_hash, version, status, created_at, last_used_at)
      VALUES (?1, ?2, ?3, 'active', ?4, ?4)
      ON CONFLICT(device_id) DO NOTHING
    `).bind(device.id, tokenHash, device.credentialVersion, now)
  ];
  for (const paired of pairedDevices) {
    statements.push(
      upsertDevice(db, paired),
      db.prepare(`
        INSERT INTO device_links (device_id, paired_device_id, created_at, revoked_at)
        VALUES (?1, ?2, ?3, NULL)
        ON CONFLICT(device_id, paired_device_id) DO UPDATE SET revoked_at = NULL
      `).bind(device.id, paired.id, now)
    );
  }
  await db.batch(statements);
}

export async function createPairingRecord(db: D1Database, input: { id: string; claimHash: string; desktopName: string; expiresAt: number }): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO pairing_sessions (id, claim_hash, desktop_name, status, created_at, expires_at)
    VALUES (?1, ?2, ?3, 'pending', ?4, ?5)
  `).bind(input.id, input.claimHash, input.desktopName, now, new Date(input.expiresAt).toISOString()).run();
}

export async function setPairingStatus(db: D1Database, id: string, status: "confirming" | "expired" | "cancelled"): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE pairing_sessions SET status = ?1
    WHERE id = ?2 AND status = 'pending'
  `).bind(status, id).run();
  return result.meta.changes === 1;
}

export async function resetPairingConfirmation(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE pairing_sessions SET status = 'pending' WHERE id = ?1 AND status = 'confirming'").bind(id).run();
}

export async function listPairedDevices(db: D1Database, deviceId: string): Promise<Device[]> {
  const result = await db.prepare(`
    SELECT d.* FROM device_links l
    JOIN devices d ON d.id = l.paired_device_id
    JOIN device_credentials c ON c.device_id = d.id
    WHERE l.device_id = ?1 AND l.revoked_at IS NULL AND d.revoked_at IS NULL AND c.status = 'active'
    ORDER BY d.last_seen_at DESC, d.created_at DESC
  `).bind(deviceId).all<DeviceRow>();
  return result.results.map(deviceFromRow);
}

export async function renameDevice(db: D1Database, deviceId: string, name: string): Promise<Device | null> {
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE devices SET name = ?1, last_seen_at = ?2 WHERE id = ?3 AND revoked_at IS NULL").bind(name, now, deviceId).run();
  if (result.meta.changes !== 1) return null;
  const row = await db.prepare("SELECT * FROM devices WHERE id = ?1").bind(deviceId).first<DeviceRow>();
  return row ? deviceFromRow(row) : null;
}

export async function revokePairedDevice(db: D1Database, actorId: string, targetId: string): Promise<boolean> {
  const linked = await db.prepare("SELECT 1 AS ok FROM device_links WHERE device_id = ?1 AND paired_device_id = ?2 AND revoked_at IS NULL").bind(actorId, targetId).first<{ ok: number }>();
  if (!linked) return false;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE device_links SET revoked_at = ?1 WHERE (device_id = ?2 AND paired_device_id = ?3) OR (device_id = ?3 AND paired_device_id = ?2)").bind(now, actorId, targetId),
    db.prepare("UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL").bind(now, targetId),
    db.prepare("UPDATE device_credentials SET status = 'revoked', revoked_at = ?1 WHERE device_id = ?2 AND status = 'active'").bind(now, targetId)
  ]);
  return true;
}

export async function rotateCredential(db: D1Database, deviceId: string, tokenHash: string): Promise<number | null> {
  const row = await db.prepare("SELECT credential_version FROM devices WHERE id = ?1 AND revoked_at IS NULL").bind(deviceId).first<{ credential_version: number }>();
  if (!row) return null;
  const version = row.credential_version + 1;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE devices SET credential_version = ?1 WHERE id = ?2").bind(version, deviceId),
    db.prepare("UPDATE device_credentials SET token_hash = ?1, version = ?2, status = 'active', created_at = ?3, last_used_at = NULL, revoked_at = NULL WHERE device_id = ?4").bind(tokenHash, version, now, deviceId)
  ]);
  return version;
}

export async function createTransfer(
  db: D1Database,
  sender: Device,
  receiverDeviceId: string,
  payload: DropPayload,
  ttlMs = DROP_TTL_MS
): Promise<DropItem | null> {
  const linked = await db.prepare(`
    SELECT d.id FROM device_links l
    JOIN devices d ON d.id = l.paired_device_id
    JOIN device_credentials c ON c.device_id = d.id
    WHERE l.device_id = ?1 AND l.paired_device_id = ?2 AND l.revoked_at IS NULL
      AND d.revoked_at IS NULL AND c.status = 'active'
  `).bind(sender.id, receiverDeviceId).first<{ id: string }>();
  if (!linked) return null;

  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const id = crypto.randomUUID();
  const status: DropStatus = payload.type === "image" ? "pending" : "delivered";
  await db.batch([
    db.prepare(`
      INSERT INTO transfers (
        id, sender_device_id, receiver_device_id, type, text_content, url, title,
        file_name, mime_type, size, status, created_at, expires_at, status_updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?12)
    `).bind(
      id, sender.id, receiverDeviceId, payload.type,
      payload.type === "text" ? payload.text : null,
      payload.type === "url" ? payload.url : null,
      payload.type === "url" ? payload.title ?? null : null,
      payload.type === "image" ? payload.fileName : null,
      payload.type === "image" ? payload.mimeType : null,
      payload.type === "image" ? payload.size : 0,
      status, createdAt, expiresAt
    ),
    db.prepare("INSERT INTO transfer_events (transfer_id, actor_device_id, status, created_at) VALUES (?1, ?2, ?3, ?4)").bind(id, sender.id, status, createdAt)
  ]);
  return { id, senderDeviceId: sender.id, senderDeviceName: sender.name, receiverDeviceId, payload, status, createdAt, expiresAt, statusUpdatedAt: createdAt };
}

export async function getTransfer(db: D1Database, transferId: string): Promise<StoredTransfer | null> {
  const row = await db.prepare(transferSelect("t.id = ?1")).bind(transferId).first<TransferRow>();
  return row ? transferFromRow(row) : null;
}

export async function completeImageTransfer(db: D1Database, transferId: string, senderDeviceId: string, objectKey: string, size: number): Promise<DropItem | null> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE transfers SET object_key = ?1, size = ?2, status = 'delivered', status_updated_at = ?3
    WHERE id = ?4 AND sender_device_id = ?5 AND type = 'image' AND status = 'pending' AND expires_at > ?3
  `).bind(objectKey, size, now, transferId, senderDeviceId).run();
  if (result.meta.changes !== 1) return null;
  await db.prepare("INSERT INTO transfer_events (transfer_id, actor_device_id, status, created_at) VALUES (?1, ?2, 'delivered', ?3)").bind(transferId, senderDeviceId, now).run();
  return (await getTransfer(db, transferId))?.item ?? null;
}

export async function failTransfer(db: D1Database, transferId: string, senderDeviceId: string, failureCode: string): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE transfers SET status = 'failed', failure_code = ?1, status_updated_at = ?2 WHERE id = ?3 AND sender_device_id = ?4 AND status = 'pending'").bind(failureCode, now, transferId, senderDeviceId),
    db.prepare("INSERT INTO transfer_events (transfer_id, actor_device_id, status, created_at) SELECT ?1, ?2, 'failed', ?3 WHERE changes() > 0").bind(transferId, senderDeviceId, now)
  ]);
}

export async function inboxPage(db: D1Database, deviceId: string, cursor: string | null, requestedLimit: number): Promise<InboxPage> {
  const limit = Math.min(Math.max(requestedLimit || DEFAULT_INBOX_LIMIT, 1), MAX_INBOX_LIMIT);
  const decoded = decodeCursor(cursor);
  const where = decoded
    ? "t.receiver_device_id = ?1 AND t.expires_at > ?2 AND t.status != 'pending' AND (t.created_at < ?3 OR (t.created_at = ?3 AND t.id < ?4))"
    : "t.receiver_device_id = ?1 AND t.expires_at > ?2 AND t.status != 'pending'";
  const statement = db.prepare(`${transferSelect(where)} ORDER BY t.created_at DESC, t.id DESC LIMIT ?${decoded ? 5 : 3}`);
  const now = new Date().toISOString();
  const result = decoded
    ? await statement.bind(deviceId, now, decoded.createdAt, decoded.id, limit + 1).all<TransferRow>()
    : await statement.bind(deviceId, now, limit + 1).all<TransferRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => transferFromRow(row).item),
    nextCursor: result.results.length > limit && last ? encodeCursor(last.created_at, last.id) : null
  };
}

export async function recentTransfers(db: D1Database, deviceId: string, limit = 20): Promise<DropItem[]> {
  const result = await db.prepare(`${transferSelect("t.sender_device_id = ?1")} ORDER BY t.created_at DESC, t.id DESC LIMIT ?2`).bind(deviceId, Math.min(Math.max(limit, 1), 20)).all<TransferRow>();
  return result.results.map((row) => transferFromRow(row).item);
}

export async function updateTransferStatus(db: D1Database, transferId: string, receiverDeviceId: string, next: "opened" | "claimed"): Promise<StoredTransfer | null> {
  const current = await getTransfer(db, transferId);
  if (!current || current.item.receiverDeviceId !== receiverDeviceId || Date.parse(current.item.expiresAt) <= Date.now()) return null;
  if (!canAdvanceDropStatus(current.item.status, next)) return current.item.status === next || current.item.status === "claimed" ? current : null;
  const now = new Date().toISOString();
  const allowedCurrent = next === "opened" ? "status = 'delivered'" : "status IN ('delivered', 'opened')";
  const [updated] = await db.batch([
    db.prepare(`
      UPDATE transfers SET status = ?1, status_updated_at = ?2
      WHERE id = ?3 AND receiver_device_id = ?4 AND expires_at > ?2 AND ${allowedCurrent}
    `).bind(next, now, transferId, receiverDeviceId),
    db.prepare(`
      INSERT INTO transfer_events (transfer_id, actor_device_id, status, created_at)
      SELECT ?1, ?2, ?3, ?4 WHERE changes() > 0
    `).bind(transferId, receiverDeviceId, next, now)
  ]);
  if (updated.meta.changes !== 1) {
    const latest = await getTransfer(db, transferId);
    return latest && (latest.item.status === next || latest.item.status === "claimed") ? latest : null;
  }
  return { item: { ...current.item, status: next, statusUpdatedAt: now }, objectKey: current.objectKey };
}

export async function expireTransfers(db: D1Database, limit = 100): Promise<Array<{ id: string; objectKey: string | null }>> {
  const now = new Date().toISOString();
  const rows = await db.prepare(`
    SELECT id, object_key FROM transfers
    WHERE expires_at <= ?1 AND status NOT IN ('expired', 'claimed')
    ORDER BY expires_at LIMIT ?2
  `).bind(now, limit).all<{ id: string; object_key: string | null }>();
  if (!rows.results.length) return [];
  const statements = rows.results.flatMap((row) => [
    db.prepare("UPDATE transfers SET status = 'expired', status_updated_at = ?1 WHERE id = ?2 AND status NOT IN ('expired', 'claimed')").bind(now, row.id),
    db.prepare("INSERT INTO transfer_events (transfer_id, status, created_at) VALUES (?1, 'expired', ?2)").bind(row.id, now)
  ]);
  await db.batch(statements);
  return rows.results.map((row) => ({ id: row.id, objectKey: row.object_key }));
}

export async function purgeExpiredRecords(db: D1Database, before: string, limit = 100): Promise<{ transfers: number; pairings: number }> {
  const [transfers, pairings] = await db.batch([
    db.prepare(`
      DELETE FROM transfers WHERE id IN (
        SELECT id FROM transfers
        WHERE expires_at <= ?1 AND status IN ('expired', 'claimed')
        ORDER BY expires_at LIMIT ?2
      )
    `).bind(before, limit),
    db.prepare(`
      DELETE FROM pairing_sessions WHERE id IN (
        SELECT id FROM pairing_sessions
        WHERE expires_at <= ?1 AND status IN ('confirmed', 'expired', 'cancelled')
        ORDER BY expires_at LIMIT ?2
      )
    `).bind(before, limit)
  ]);
  return { transfers: transfers.meta.changes ?? 0, pairings: pairings.meta.changes ?? 0 };
}

function transferSelect(where: string): string {
  return `
    SELECT t.*, sender.name AS sender_name
    FROM transfers t
    JOIN devices sender ON sender.id = t.sender_device_id
    WHERE ${where}
  `;
}

function transferFromRow(row: TransferRow): StoredTransfer {
  const payload: DropPayload = row.type === "text"
    ? { type: "text", text: row.text_content ?? "" }
    : row.type === "url"
      ? { type: "url", url: row.url ?? "", title: row.title ?? undefined }
      : { type: "image", fileName: row.file_name ?? "image", mimeType: imageMime(row.mime_type), size: row.size };
  return {
    item: {
      id: row.id,
      senderDeviceId: row.sender_device_id,
      senderDeviceName: row.sender_name,
      receiverDeviceId: row.receiver_device_id,
      payload,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      statusUpdatedAt: row.status_updated_at,
      failureReason: row.failure_code ?? undefined
    },
    objectKey: row.object_key
  };
}

function deviceFromRow(row: DeviceRow): Device {
  let capabilities: Device["capabilities"] = ["drop.send", "drop.receive"];
  try {
    const parsed = JSON.parse(row.capabilities) as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter(isCapability);
  } catch { /* use safe defaults */ }
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    capabilities,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    credentialVersion: row.credential_version
  };
}

function insertDevice(db: D1Database, device: Device): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO devices (id, name, platform, capabilities, created_at, last_seen_at, credential_version, revoked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(device.id, device.name, device.platform, JSON.stringify(device.capabilities), device.createdAt, device.lastSeenAt ?? null, device.credentialVersion, device.revokedAt ?? null);
}

function upsertDevice(db: D1Database, device: Device): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO devices (id, name, platform, capabilities, created_at, last_seen_at, credential_version, revoked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      platform = excluded.platform,
      capabilities = excluded.capabilities,
      last_seen_at = COALESCE(excluded.last_seen_at, devices.last_seen_at),
      credential_version = MAX(devices.credential_version, excluded.credential_version)
  `).bind(device.id, device.name, device.platform, JSON.stringify(device.capabilities), device.createdAt, device.lastSeenAt ?? null, device.credentialVersion, device.revokedAt ?? null);
}

function insertCredential(db: D1Database, deviceId: string, tokenHash: string, version: number, createdAt: string): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO device_credentials (device_id, token_hash, version, status, created_at)
    VALUES (?1, ?2, ?3, 'active', ?4)
  `).bind(deviceId, tokenHash, version, createdAt);
}

function imageMime(value: string | null): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  return value === "image/jpeg" || value === "image/webp" || value === "image/gif" ? value : "image/png";
}

function isCapability(value: unknown): value is Device["capabilities"][number] {
  return value === "drop.send" || value === "drop.receive" || value === "pulse.publish" || value === "pulse.consume";
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ createdAt, id })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(value: string | null): { createdAt: string; id: string } | null {
  if (!value || value.length > 512) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(normalized)) as unknown;
    if (!parsed || typeof parsed !== "object" || !("createdAt" in parsed) || !("id" in parsed)) return null;
    return typeof parsed.createdAt === "string" && typeof parsed.id === "string" ? { createdAt: parsed.createdAt, id: parsed.id } : null;
  } catch { return null; }
}
