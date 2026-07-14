export type DeviceType = "mac" | "phone" | "tablet" | "windows" | "web";

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  createdAt: string;
  lastSeenAt?: string;
}

export type DropPayload =
  | { type: "text"; text: string }
  | { type: "url"; url: string; title?: string };

export type DropStatus = "sent" | "delivered" | "opened" | "expired";

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

export interface DeviceCredential {
  device: Device;
  token: string;
}

export interface PairingSessionResponse {
  id: string;
  claimToken: string;
  pairUrl: string;
  expiresAt: string;
}

export type PairingStatusResponse =
  | { status: "pending"; expiresAt: string }
  | { status: "confirmed"; credential: DeviceCredential; receiver: Device }
  | { status: "expired" };

export interface ApiProblem {
  error: { code: string; message: string };
}
