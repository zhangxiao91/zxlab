export type DevicePlatform = "macos" | "android" | "ios" | "windows" | "linux" | "web";
export type DeviceCapability = "drop.send" | "drop.receive" | "pulse.publish" | "pulse.consume";

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  capabilities: DeviceCapability[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  credentialVersion: number;
  publicKey?: string;
  keyVersion?: number;
}

export type DropPayload =
  | { type: "text"; text: string }
  | { type: "url"; url: string; title?: string };

export type DropStatus = "pending" | "sent" | "delivered" | "opened" | "expired" | "failed";

export interface DropItem {
  id: string;
  senderDeviceId: string;
  senderDeviceName: string;
  receiverDeviceId: string;
  payload: DropPayload;
  status: DropStatus;
  createdAt: string;
  expiresAt: string;
}

export type Presence = "online" | "recently_online" | "offline";
export type BatteryLevel = "high" | "medium" | "low";
export type StepsBucket = "0-2k" | "2k-5k" | "5k-8k" | "8k-12k" | "12k+";

export interface PrivacyRule {
  enabled: boolean;
  precision: "exact" | "bucket" | "coarse";
  delayMinutes: number;
  expiresAfterMinutes: number;
}

export interface PublicPulseSnapshot {
  device: { presence: Presence; batteryLevel?: BatteryLevel; charging?: boolean };
  activity?: { stepsBucket?: StepsBucket };
  generatedAt: string;
  expiresAt: string;
  schemaVersion: 1;
}

export interface PublicStatusResponse {
  updatedAt: string | null;
  stale: boolean;
  devices: Array<{ name: string; presence: Presence; batteryLevel?: BatteryLevel; charging?: boolean }>;
  activity?: { stepsBucket?: StepsBucket };
}

export interface DeviceCredential { device: Device; token: string; }
export interface PairingSessionResponse { id: string; claimToken: string; pairUrl: string; expiresAt: string; }
export type PairingStatusResponse =
  | { status: "pending"; expiresAt: string }
  | { status: "confirmed"; credential: DeviceCredential; receiver: Device }
  | { status: "expired" };
export interface ApiProblem { error: { code: string; message: string }; }
