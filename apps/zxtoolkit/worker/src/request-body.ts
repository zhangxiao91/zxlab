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
