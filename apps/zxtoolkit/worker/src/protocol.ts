export const SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type TransferStatus = "uploading" | "ready" | "claimed" | "deleted" | "expired" | "failed";

export interface TransferRecord {
  id: string;
  objectKey: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: TransferStatus;
  createdAt: number;
  expiresAt: number;
}

export type SocketMessage =
  | { type: "connected"; role: "sender" | "receiver"; expiresAt: number; peerOnline: boolean; transfer?: TransferRecord }
  | { type: "peer_status"; role: "sender" | "receiver"; online: boolean }
  | { type: "transfer_ready"; transfer: TransferRecord }
  | { type: "transfer_claimed"; transferId: string }
  | { type: "transfer_deleted"; transferId: string }
  | { type: "session_expired" }
  | { type: "error"; code: string; message: string };

export function parseClientMessage(value: string | ArrayBuffer): { type: "ping" } | { type: "claim"; transferId: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
    if (parsed.type === "ping") return { type: "ping" };
    if (parsed.type === "claim" && "transferId" in parsed && typeof parsed.transferId === "string") {
      return { type: "claim", transferId: parsed.transferId };
    }
    return null;
  } catch {
    return null;
  }
}

export function validateUpload(contentType: string, size: number, maxBytes = MAX_FILE_BYTES): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase())) return "仅支持 PNG、JPEG、WebP 和 GIF 图片";
  if (!Number.isFinite(size) || size <= 0) return "文件为空或大小无效";
  if (size > maxBytes) return "单个文件不能超过 20 MB";
  return null;
}

export function validateUploadMetadata(contentType: string, declaredSize: number | null, maxBytes = MAX_FILE_BYTES): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase())) return "仅支持 PNG、JPEG、WebP 和 GIF 图片";
  if (declaredSize === null) return null;
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) return "文件为空或大小无效";
  if (declaredSize > maxBytes) return "单个文件不能超过 20 MB";
  return null;
}

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  const allowed: Record<TransferStatus, TransferStatus[]> = {
    uploading: ["ready", "failed", "expired"],
    ready: ["claimed", "deleted", "expired", "failed"],
    claimed: ["deleted"],
    deleted: [],
    expired: ["deleted"],
    failed: ["uploading", "deleted"]
  };
  return allowed[from].includes(to);
}

export function shouldDeleteExpiredTransfer(transfer: Pick<TransferRecord, "expiresAt" | "status">, now = Date.now()): boolean {
  return transfer.expiresAt <= now && transfer.status !== "deleted";
}
