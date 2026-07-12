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
