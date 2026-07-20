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

const textDrop = await request("/api/drops", {
  method: "POST",
  headers: jsonAuth(desktop),
  body: JSON.stringify({ receiverDeviceId: mobile.device.id, payload: { type: "text", text: "smoke test" } })
});
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
  body: JSON.stringify({ device: { presence: "online", batteryLevel: "high", charging: true }, generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), schemaVersion: 1 })
});
const latestPulse = await request("/api/pulse/snapshots/latest", { headers: auth(rotated.credential) });
ensure(latestPulse.snapshot?.device?.presence === "online", "rotated credential cannot read Pulse");
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

inbox = await request("/api/inbox", { headers: auth(mobile) });
await request(`/api/devices/${mobile.device.id}`, { method: "DELETE", headers: auth(rotated.credential) });
const revokedInbox = await fetch(`${baseUrl}/api/inbox`, { headers: auth(mobile) });
ensure(revokedInbox.status === 401, "revoked device could still read inbox");
console.log(JSON.stringify({
  ok: true,
  paired: true,
  textDelivered: true,
  imageClaimDeleted: true,
  rotatedCredentialPulse: true,
  revokedCredential: true,
  pagination: true,
  realtimeTicket: true,
  inboxItems: inbox.items.length
}));
