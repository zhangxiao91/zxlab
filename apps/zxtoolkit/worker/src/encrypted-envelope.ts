interface EncryptedEnvelope {
  schemaVersion: 1;
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
}

const context = "zxtoolkit-pulse-v1";

export async function decryptPulseEnvelope(value: unknown, token: string): Promise<unknown | null> {
  if (!isEnvelope(value) || token.length < 32) return null;
  try {
    const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${context}\0${token}`));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(value.iv), additionalData: new TextEncoder().encode(context) },
      key,
      decode(value.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(clear)) as unknown;
  } catch {
    return null;
  }
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.schemaVersion === 1 && input.algorithm === "A256GCM" &&
    typeof input.iv === "string" && input.iv.length <= 32 &&
    typeof input.ciphertext === "string" && input.ciphertext.length <= 4096;
}

function decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
