const context = "zxtoolkit-pulse-v1";

export async function encryptPulseSnapshot(value: unknown, deviceToken: string) {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${context}\0${deviceToken}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    schemaVersion: 1,
    algorithm: "A256GCM",
    iv: encode(iv),
    ciphertext: encode(new Uint8Array(ciphertext)),
  };
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
