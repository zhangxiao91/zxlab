const baseUrl = process.env.ZXTOOLKIT_SMOKE_BASE_URL || "http://localhost:8787";

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.arrayBuffer();
  if (!response.ok) {
    const code = body && typeof body === "object" && "error" in body ? body.error?.code : "REQUEST_FAILED";
    throw new Error(`${response.status} ${code || "REQUEST_FAILED"}`);
  }
  return body;
}

function auth(credential) {
  return { authorization: `Bearer ${credential.token}`, "x-device-id": credential.device.id };
}

function jsonAuth(credential) {
  return { ...auth(credential), "content-type": "application/json" };
}

function ensure(value, message) {
  if (!value) throw new Error(message);
}

async function encryptedPulse(snapshot, token) {
  const context = "zxtoolkit-pulse-v1";
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${context}\0${token}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  const encode = (value) => Buffer.from(value).toString("base64url");
  return { schemaVersion: 1, algorithm: "A256GCM", iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

await request("/api/health");
const pairing = await request("/api/pairing/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ desktopName: "Smoke Mac" })
});
const mobileResult = await request(`/api/pairing/sessions/${pairing.id}/confirm`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Smoke Phone", platform: "ios" })
});
const duplicatePairing = await fetch(`${baseUrl}/api/pairing/sessions/${pairing.id}/confirm`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Second Phone", platform: "ios" })
});
ensure(duplicatePairing.status === 409, "pairing code was accepted more than once");
const pairingStatus = await request(`/api/pairing/sessions/${pairing.id}`, {
  headers: { authorization: `Bearer ${pairing.claimToken}` }
});
ensure(pairingStatus.status === "confirmed", "pairing did not confirm");

const desktop = pairingStatus.credential;
const mobile = mobileResult.credential;
const devices = await request("/api/devices", { headers: auth(desktop) });
ensure(devices.pairedDevices.some((device) => device.id === mobile.device.id), "paired device is missing");

const addDevicePairing = await request("/api/pairing/sessions/add-device", {
  method: "POST",
  headers: auth(desktop)
});
ensure(addDevicePairing.mode === "add_device", "authenticated pairing mode is invalid");
const addDevicePreview = await request(`/api/pairing/sessions/${addDevicePairing.id}/preview`);
ensure(addDevicePreview.desktopName === desktop.device.name && addDevicePreview.mode === "add_device", "Android pairing preview is invalid");
const androidResult = await request(`/api/pairing/sessions/${addDevicePairing.id}/confirm`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Smoke Android", platform: "android" })
});
const addDeviceStatus = await request(`/api/pairing/sessions/${addDevicePairing.id}`, {
  headers: { authorization: `Bearer ${addDevicePairing.claimToken}` }
});
const usedPairingPreview = await fetch(`${baseUrl}/api/pairing/sessions/${addDevicePairing.id}/preview`);
ensure(usedPairingPreview.status === 410, "confirmed pairing remained previewable");
ensure(addDeviceStatus.status === "confirmed" && addDeviceStatus.mode === "add_device" && !("credential" in addDeviceStatus), "add-device pairing replaced the Mac credential");
const android = androidResult.credential;
const devicesAfterAdd = await request("/api/devices", { headers: auth(desktop) });
ensure(devicesAfterAdd.pairedDevices.some((device) => device.id === android.device.id), "Android device was not attached to the existing Mac");
const siblingDrop = await fetch(`${baseUrl}/api/drops`, {
  method: "POST",
  headers: jsonAuth(android),
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "text", text: "must not cross the star" } })
});
ensure(siblingDrop.status === 403, "Android could send directly to a sibling Web device");

const textDrop = await request("/api/drops", {
  method: "POST",
  headers: { ...jsonAuth(desktop), "x-idempotency-key": "smoke-text-drop" },
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "text", text: "smoke test" } })
});
const repeatedTextDrop = await request("/api/drops", {
  method: "POST",
  headers: { ...jsonAuth(desktop), "x-idempotency-key": "smoke-text-drop" },
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "text", text: "smoke test" } })
});
ensure(repeatedTextDrop.item.id === textDrop.item.id, "idempotent text retry created a duplicate transfer");
const urlDrop = await request("/api/drops", {
  method: "POST",
  headers: jsonAuth(desktop),
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "url", url: "https://zx-dx.xyz/lab", title: "zxlab" } })
});
ensure(urlDrop.item.payload.type === "url", "URL drop was not created");
const unsafeUrl = await fetch(`${baseUrl}/api/drops`, {
  method: "POST",
  headers: jsonAuth(desktop),
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "url", url: "javascript:alert(1)" } })
});
ensure(unsafeUrl.status === 400, "dangerous URL scheme was accepted");
let inbox = await request("/api/inbox", { headers: auth(mobile) });
ensure(inbox.items.some((item) => item.id === textDrop.item.id), "text drop is missing from inbox");
await request(`/api/transfers/${textDrop.item.id}/status`, {
  method: "PATCH",
  headers: jsonAuth(mobile),
  body: JSON.stringify({ status: "claimed" })
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const imageDrop = await request("/api/drops", {
  method: "POST",
  headers: jsonAuth(desktop),
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "image", fileName: "smoke.png", mimeType: "image/png", size: png.byteLength } })
});
await request(`/api/transfers/${imageDrop.item.id}/content`, {
  method: "POST",
  headers: { ...auth(desktop), "content-type": "image/png" },
  body: png
});
const rangedResponse = await fetch(`${baseUrl}/api/transfers/${imageDrop.item.id}/download`, { headers: { ...auth(mobile), range: "bytes=4-7" } });
ensure(rangedResponse.status === 206 && rangedResponse.headers.get("content-range") === `bytes 4-7/${png.byteLength}`, "range download response is invalid");
ensure((await rangedResponse.arrayBuffer()).byteLength === 4, "range download returned the wrong number of bytes");
const downloaded = await request(`/api/transfers/${imageDrop.item.id}/download`, { headers: auth(mobile) });
ensure(downloaded.byteLength === png.byteLength, "downloaded image size does not match");
const crossDeviceDownload = await fetch(`${baseUrl}/api/transfers/${imageDrop.item.id}/download`, { headers: auth(desktop) });
ensure(crossDeviceDownload.status === 404, "sender could download receiver-only image");
await request(`/api/transfers/${imageDrop.item.id}/status`, {
  method: "PATCH",
  headers: jsonAuth(mobile),
  body: JSON.stringify({ status: "claimed" })
});
await request(`/api/transfers/${imageDrop.item.id}/status`, {
  method: "PATCH",
  headers: jsonAuth(mobile),
  body: JSON.stringify({ status: "claimed" })
});
const unavailable = await fetch(`${baseUrl}/api/transfers/${imageDrop.item.id}/download`, { headers: auth(mobile) });
ensure(unavailable.status === 410, "claimed image remains downloadable");

const phoneText = await request("/api/drops", {
  method: "POST",
  headers: jsonAuth(mobile),
  body: JSON.stringify({ receiverDeviceId: desktop.device.id, payload: { type: "text", text: "phone to mac" } })
});
let desktopInbox = await request("/api/inbox", { headers: auth(desktop) });
ensure(desktopInbox.items.some((item) => item.id === phoneText.item.id), "phone-to-Mac text drop is missing");
const androidText = await request("/api/drops", {
  method: "POST",
  headers: jsonAuth(android),
  body: JSON.stringify({ receiverDeviceId: desktop.device.id, payload: { type: "text", text: "android to mac" } })
});
desktopInbox = await request("/api/inbox", { headers: auth(desktop) });
ensure(desktopInbox.items.some((item) => item.id === androidText.item.id), "Android-to-Mac text drop is missing");

const documentBytes = new TextEncoder().encode("zxtoolkit bidirectional file");
const phoneFile = await request("/api/drops", {
  method: "POST",
  headers: jsonAuth(mobile),
  body: JSON.stringify({ receiverDeviceId: desktop.device.id, payload: { type: "file", fileName: "smoke.txt", mimeType: "text/plain", size: documentBytes.byteLength } })
});
await request(`/api/transfers/${phoneFile.item.id}/content`, {
  method: "POST",
  headers: { ...auth(mobile), "content-type": "text/plain" },
  body: documentBytes
});
const downloadedFile = await request(`/api/transfers/${phoneFile.item.id}/download`, { headers: auth(desktop) });
ensure(downloadedFile.byteLength === documentBytes.byteLength, "phone-to-Mac file size does not match");
await request(`/api/transfers/${phoneFile.item.id}/status`, {
  method: "PATCH",
  headers: jsonAuth(desktop),
  body: JSON.stringify({ status: "claimed" })
});
const deletedFile = await fetch(`${baseUrl}/api/transfers/${phoneFile.item.id}/download`, { headers: auth(desktop) });
ensure(deletedFile.status === 410, "claimed phone-to-Mac file remains downloadable");

const previousDesktop = structuredClone(desktop);
const rotated = await request("/api/devices/credential/rotate", { method: "POST", headers: auth(desktop) });
const oldCredential = await fetch(`${baseUrl}/api/devices`, { headers: auth(previousDesktop) });
ensure(oldCredential.status === 401, "old credential remained active after rotation");
const renamed = await request(`/api/devices/${rotated.credential.device.id}`, {
  method: "PATCH",
  headers: jsonAuth(rotated.credential),
  body: JSON.stringify({ name: "Renamed Smoke Mac" })
});
ensure(renamed.device.name === "Renamed Smoke Mac", "device rename did not persist");
const now = Date.now();
await request("/api/pulse/snapshots", {
  method: "POST",
  headers: jsonAuth(rotated.credential),
  body: JSON.stringify(await encryptedPulse({ device: { presence: "online", batteryPercent: 87, charging: true }, activity: { steps: 6_500 }, generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), schemaVersion: 1 }, rotated.credential.token))
});
const latestPulse = await request("/api/pulse/snapshots/latest", { headers: auth(rotated.credential) });
ensure(latestPulse.snapshot?.device?.presence === "online" && latestPulse.snapshot?.device?.batteryPercent === 87 && latestPulse.snapshot?.activity?.steps === 6_500, "rotated credential cannot read exact Pulse telemetry");
const musicEvent = {
  eventId: "evt_smoke_music_01",
  sessionId: "ses_smoke_music_01",
  eventType: "track_started",
  packageName: "com.netease.cloudmusic",
  fingerprint: "a".repeat(64),
  track: { title: "Smoke Track", artist: "Smoke Artist", durationMs: 180000 },
  playback: { state: "playing", positionMs: 1200, speed: 1 },
  occurredAt: new Date(now).toISOString(),
  elapsedRealtimeMs: 123456,
};
const musicBatch = { schemaVersion: 1, batchId: "batch_smoke_music_01", sentAt: new Date(now).toISOString(), events: [musicEvent] };
const firstMusic = await request("/api/music/events/batch", { method: "POST", headers: jsonAuth(android), body: JSON.stringify(musicBatch) });
const duplicateMusic = await request("/api/music/events/batch", { method: "POST", headers: jsonAuth(android), body: JSON.stringify(musicBatch) });
ensure(firstMusic.accepted.includes(musicEvent.eventId), "music event was not accepted");
ensure(duplicateMusic.duplicates.includes(musicEvent.eventId), "duplicate music event was not idempotent");
const playing = await request("/api/music/now-playing", { headers: auth(android) });
ensure(playing.nowPlaying?.title === "Smoke Track" && playing.summary?.playsToday >= 1, "current playback projection is invalid");
const ticket = await request("/api/inbox/events/ticket", { method: "POST", headers: auth(mobile) });
ensure(ticket.ticket && ticket.expiresAt > Date.now(), "inbox socket ticket was not issued");

for (const text of ["page one", "page two", "page three"]) {
  await request("/api/drops", {
    method: "POST",
    headers: jsonAuth(rotated.credential),
    body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "text", text } })
  });
}
const firstPage = await request("/api/inbox?limit=2", { headers: auth(mobile) });
ensure(firstPage.items.length === 2 && firstPage.nextCursor, "inbox first page or cursor is invalid");
const secondPage = await request(`/api/inbox?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: auth(mobile) });
ensure(secondPage.items.length > 0 && !secondPage.items.some((item) => firstPage.items.some((first) => first.id === item.id)), "inbox cursor returned duplicate items");

await request(`/api/devices/${android.device.id}`, { method: "DELETE", headers: auth(android) });
const selfRevokedAndroid = await fetch(`${baseUrl}/api/devices`, { headers: auth(android) });
ensure(selfRevokedAndroid.status === 401, "self-unlinked Android credential remained active");
const desktopAfterAndroidUnlink = await request("/api/devices", { headers: auth(rotated.credential) });
ensure(!desktopAfterAndroidUnlink.pairedDevices.some((device) => device.id === android.device.id), "self-unlinked Android remained attached to the Mac");

inbox = await request("/api/inbox", { headers: auth(mobile) });
await request(`/api/devices/${mobile.device.id}`, { method: "DELETE", headers: auth(rotated.credential) });
const revokedInbox = await fetch(`${baseUrl}/api/inbox`, { headers: auth(mobile) });
ensure(revokedInbox.status === 401, "revoked device could still read inbox");
console.log(JSON.stringify({
  ok: true,
  paired: true,
  addDevicePairing: true,
  starTopology: true,
  textDelivered: true,
  deliveryIdempotency: true,
  rangeDownload: true,
  bidirectionalText: true,
  bidirectionalFile: true,
  imageClaimDeleted: true,
  rotatedCredentialPulse: true,
  encryptedPulse: true,
  neteasePlayback: true,
  playbackIdempotency: true,
  revokedCredential: true,
  selfUnlink: true,
  pagination: true,
  realtimeTicket: true,
  inboxItems: inbox.items.length
}));
