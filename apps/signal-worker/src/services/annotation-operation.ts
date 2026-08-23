import type { AnnotationInput, AnnotationResponse } from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { AnnotationRepository } from "../repositories/annotation-repository";

interface OperationRow {
  key_hash: string;
  request_hash: string;
  status: "processing" | "succeeded" | "failed";
  annotation_id: string | null;
  lease_expires_at: string | null;
}

export interface AnnotationOperationCommit {
  keyHash: string;
  leaseToken: string;
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorCode(cause: unknown): string {
  return cause instanceof SignalError ? cause.code : "ANNOTATION_FAILED";
}

export class AnnotationOperation {
  private readonly annotations: AnnotationRepository;

  constructor(private readonly db: D1Database, private readonly now: () => Date = () => new Date()) {
    this.annotations = new AnnotationRepository(db);
  }

  async run(idempotencyKey: string, input: AnnotationInput,
    execute: (commit: AnnotationOperationCommit) => Promise<AnnotationResponse>): Promise<AnnotationResponse> {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(idempotencyKey)) {
      throw new SignalError("INVALID_REQUEST", "Idempotency-Key must be a UUID", 400);
    }
    const keyHash = await hash(idempotencyKey);
    const requestHash = await hash(JSON.stringify(input));
    const leaseToken = crypto.randomUUID();
    const timestamp = this.now().toISOString();
    const leaseExpiresAt = new Date(this.now().getTime() + 4 * 60_000).toISOString();
    const inserted = await this.db.prepare(`INSERT OR IGNORE INTO annotation_operations
      (key_hash, request_hash, status, lease_token, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'processing', ?, ?, ?, ?)`)
      .bind(keyHash, requestHash, leaseToken, leaseExpiresAt, timestamp, timestamp).run();
    let owned = Number(inserted.meta.changes ?? 0) === 1;
    let operation = await this.get(keyHash);
    if (operation.request_hash !== requestHash) {
      throw new SignalError("INVALID_REQUEST", "Idempotency-Key was already used for another request", 409);
    }
    if (!owned && operation.status === "succeeded" && operation.annotation_id) {
      return this.annotations.getResponse(operation.annotation_id);
    }
    if (!owned && (operation.status === "failed" || (operation.lease_expires_at && operation.lease_expires_at <= timestamp))) {
      const claimed = await this.db.prepare(`UPDATE annotation_operations SET status='processing', lease_token=?, lease_expires_at=?,
        error_code=NULL, updated_at=? WHERE key_hash=? AND request_hash=?
        AND (status='failed' OR lease_expires_at<=?)`)
        .bind(leaseToken, leaseExpiresAt, timestamp, keyHash, requestHash, timestamp).run();
      owned = Number(claimed.meta.changes ?? 0) === 1;
      operation = await this.get(keyHash);
    }
    if (!owned) throw new SignalError("MEMORY_ALREADY_RESOLVED", "Annotation operation is already processing", 409);
    try {
      const response = await execute({ keyHash, leaseToken });
      return response;
    } catch (cause) {
      await this.db.prepare(`UPDATE annotation_operations SET status='failed', lease_token=NULL, lease_expires_at=NULL,
        error_code=?, updated_at=? WHERE key_hash=? AND lease_token=?`)
        .bind(errorCode(cause), this.now().toISOString(), keyHash, leaseToken).run();
      throw cause;
    }
  }

  private async get(keyHash: string): Promise<OperationRow> {
    const row = await this.db.prepare("SELECT * FROM annotation_operations WHERE key_hash=?").bind(keyHash).first<OperationRow>();
    if (!row) throw new SignalError("DATABASE_WRITE_FAILED", "Annotation operation could not be reserved", 500);
    return row;
  }
}
