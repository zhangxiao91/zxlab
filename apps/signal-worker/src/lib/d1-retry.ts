export interface D1BatchRetryOptions {
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;

export function isD1StorageTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("d1 db storage operation exceeded timeout");
}

export async function batchWithD1Retry<T>(
  db: Pick<D1Database, "batch">,
  createStatements: () => D1PreparedStatement[],
  options: D1BatchRetryOptions = {},
): Promise<D1Result<T>[]> {
  const configuredAttempts = options.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(configuredAttempts) ? Math.max(1, Math.floor(configuredAttempts)) : 3;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.batch<T>(createStatements());
    } catch (error) {
      if (!isD1StorageTimeout(error) || attempt >= maxAttempts) throw error;
      const delayMs = delays[attempt - 1] ?? delays[delays.length - 1] ?? 0;
      console.warn(JSON.stringify({
        event: "signal.d1.batch.retry",
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        reason: "storage_timeout",
      }));
      await sleep(delayMs);
    }
  }

  throw new Error("D1 batch retry loop exited unexpectedly");
}
