export type TransferStatus = "ready" | "sending" | "sent" | "failed";

export interface LocalTransfer {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: number;
  status: TransferStatus;
}

export interface StoredFile extends LocalTransfer {
  blob: Blob;
}

export interface TransferSession {
  id: string;
  token: string;
  expiresAt: number;
}

export interface RemoteTransfer {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: "ready" | "claimed" | "deleted" | "expired";
  createdAt: number;
  expiresAt: number;
}

export type SessionSocketMessage =
  | { type: "connected"; role: "sender" | "receiver"; expiresAt: number; peerOnline: boolean; transfer?: RemoteTransfer }
  | { type: "peer_status"; role: "sender" | "receiver"; online: boolean }
  | { type: "transfer_ready"; transfer: RemoteTransfer }
  | { type: "transfer_claimed"; transferId: string }
  | { type: "transfer_deleted"; transferId: string }
  | { type: "session_expired" }
  | { type: "error"; code: string; message: string };
