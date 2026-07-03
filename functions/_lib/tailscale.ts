import type { DeviceStatus, DeviceType } from "../../src/status/types";

export interface TailscaleEnv {
  TAILSCALE_OAUTH_CLIENT_ID?: string;
  TAILSCALE_OAUTH_CLIENT_SECRET?: string;
  TAILSCALE_PUBLIC_DEVICES?: string;
  TAILSCALE_TAILNET?: string;
}

interface TailscaleDevice {
  id?: string;
  hostname?: string;
  name?: string;
  connectedToControl?: boolean;
  lastSeen?: string;
}

interface TailscaleDeviceResponse {
  devices?: TailscaleDevice[];
}

interface TailscaleTokenResponse {
  access_token?: string;
}

interface PublicDeviceDefinition {
  id?: string;
  name: string;
  type: DeviceType;
  publicTask?: string;
}

type PublicDeviceMap = Record<string, PublicDeviceDefinition>;
type Fetcher = typeof fetch;

const deviceTypes = new Set<DeviceType>([
  "desktop",
  "laptop",
  "phone",
  "server",
  "node",
  "other",
]);

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function publicId(value: string, fallback: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

export function parsePublicDeviceMap(value: string | undefined): PublicDeviceMap {
  if (!value) return {};

  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error("TAILSCALE_PUBLIC_DEVICES must be valid JSON");
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("TAILSCALE_PUBLIC_DEVICES must be a JSON object");
  }

  const definitions: PublicDeviceMap = {};
  for (const [privateKey, definition] of Object.entries(candidate)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    const input = definition as Record<string, unknown>;
    const name = text(input.name, 64);
    const type = text(input.type, 16) as DeviceType;
    if (!name || !deviceTypes.has(type)) continue;

    const id = text(input.id, 48);
    const publicTask = text(input.publicTask, 96);
    definitions[privateKey] = {
      name,
      type,
      ...(id ? { id } : {}),
      ...(publicTask ? { publicTask } : {}),
    };
  }

  return definitions;
}

export function sanitizeTailscaleDevices(
  devices: TailscaleDevice[],
  definitions: PublicDeviceMap,
  updatedAt = new Date().toISOString(),
): DeviceStatus[] {
  const usedIds = new Set<string>();

  return devices.flatMap((device, index) => {
    const definition = [device.id, device.hostname, device.name]
      .filter((key): key is string => Boolean(key))
      .map((key) => definitions[key])
      .find(Boolean);
    if (!definition) return [];

    const baseId = publicId(definition.id ?? definition.name, `device-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);

    const connected = device.connectedToControl === true;
    const previousSeen = text(device.lastSeen, 64);
    const lastSeen = connected ? updatedAt : previousSeen || updatedAt;
    const state = connected ? "online" : previousSeen ? "offline" : "unknown";

    return [{
      id,
      name: definition.name,
      type: definition.type,
      state,
      lastSeen,
      ...(definition.publicTask ? { publicTask: definition.publicTask } : {}),
      updatedAt,
    } satisfies DeviceStatus];
  });
}

async function requestWithTimeout(
  fetcher: Fetcher,
  input: string,
  init: RequestInit,
  timeoutMs = 7000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(env: TailscaleEnv, fetcher: Fetcher) {
  if (!env.TAILSCALE_OAUTH_CLIENT_ID || !env.TAILSCALE_OAUTH_CLIENT_SECRET) {
    throw new Error("Tailscale OAuth credentials are not configured");
  }

  const body = new URLSearchParams({
    client_id: env.TAILSCALE_OAUTH_CLIENT_ID,
    client_secret: env.TAILSCALE_OAUTH_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "devices:core:read",
  });
  const response = await requestWithTimeout(
    fetcher,
    "https://api.tailscale.com/api/v2/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) throw new Error(`Tailscale OAuth failed with ${response.status}`);

  const payload = await response.json() as TailscaleTokenResponse;
  if (!payload.access_token) throw new Error("Tailscale OAuth returned no access token");
  return payload.access_token;
}

export async function getPublicTailscaleDevices(
  env: TailscaleEnv,
  fetcher: Fetcher = fetch,
) {
  const definitions = parsePublicDeviceMap(env.TAILSCALE_PUBLIC_DEVICES);
  if (Object.keys(definitions).length === 0) {
    throw new Error("No public Tailscale devices are allowlisted");
  }

  const accessToken = await getAccessToken(env, fetcher);
  const tailnet = encodeURIComponent(env.TAILSCALE_TAILNET || "-");
  const response = await requestWithTimeout(
    fetcher,
    `https://api.tailscale.com/api/v2/tailnet/${tailnet}/devices`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Tailscale devices request failed with ${response.status}`);

  const payload = await response.json() as TailscaleDeviceResponse;
  return sanitizeTailscaleDevices(payload.devices ?? [], definitions);
}
