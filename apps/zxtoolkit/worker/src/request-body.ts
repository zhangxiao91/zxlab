export class BodyTooLargeError extends Error {
  constructor() {
    super("BODY_TOO_LARGE");
  }
}

export function declaredBodySize(header: string | null): number | null {
  if (header === null) return null;
  const size = Number(header);
  return Number.isSafeInteger(size) && size >= 0 ? size : Number.NaN;
}

export async function readBodyWithLimit(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export interface GuardedBodyStream {
  body: ReadableStream<Uint8Array>;
  prefix: Uint8Array;
  completed: Promise<{ size: number }>;
}

export async function guardedBodyStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  prefixBytes = 12
): Promise<GuardedBodyStream> {
  const reader = source.getReader();
  const buffered: Uint8Array[] = [];
  const prefix = new Uint8Array(Math.max(0, prefixBytes));
  let prefixLength = 0;
  let size = 0;

  try {
    while (prefixLength < prefix.length) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new BodyTooLargeError();
      }
      buffered.push(value);
      const take = Math.min(value.byteLength, prefix.length - prefixLength);
      prefix.set(value.subarray(0, take), prefixLength);
      prefixLength += take;
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  let resolveCompleted!: (value: { size: number }) => void;
  let rejectCompleted!: (reason: unknown) => void;
  const completed = new Promise<{ size: number }>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of buffered) controller.enqueue(chunk);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel("size limit exceeded");
            throw new BodyTooLargeError();
          }
          controller.enqueue(value);
        }
        controller.close();
        resolveCompleted({ size });
      } catch (error) {
        controller.error(error);
        rejectCompleted(error);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      rejectCompleted(reason instanceof Error ? reason : new Error("UPLOAD_CANCELLED"));
    }
  });

  return { body, prefix: prefix.subarray(0, prefixLength), completed };
}

export async function readJsonWithLimit(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  if (!request.body) return null;
  try {
    const body = await readBodyWithLimit(request.body, maxBytes);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function hasImageSignature(body: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") return startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === "image/jpeg") return startsWith(body, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") return startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  if (mimeType === "image/webp") {
    return startsWith(body, [0x52, 0x49, 0x46, 0x46]) && body.length >= 12 && startsWith(body.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  }
  return false;
}

function startsWith(body: Uint8Array, signature: number[]): boolean {
  return body.length >= signature.length && signature.every((byte, index) => body[index] === byte);
}
