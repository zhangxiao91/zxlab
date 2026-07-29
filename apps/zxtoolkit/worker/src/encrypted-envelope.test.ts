import { describe, expect, it } from "vitest";
import { decryptPulseEnvelope } from "./encrypted-envelope";

const context = "zxtoolkit-pulse-v1";

async function encrypt(value: unknown, token: string) {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${context}\0${token}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { schemaVersion: 1, algorithm: "A256GCM", iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

describe("encrypted Pulse envelope", () => {
  it("decrypts only with the authenticated device token", async () => {
    const token = "a".repeat(64);
    const envelope = await encrypt({ device: { presence: "online" } }, token);
    await expect(decryptPulseEnvelope(envelope, token)).resolves.toEqual({ device: { presence: "online" } });
    await expect(decryptPulseEnvelope(envelope, "b".repeat(64))).resolves.toBeNull();
  });
});
