import { DurableObject } from "cloudflare:workers";
import type { SocketMessage, TransferRecord } from "./protocol";
import { canTransition, parseClientMessage } from "./protocol";
import { constantTimeEqual, hashToken } from "./security";

interface SessionState {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  uploadCount: number;
  transfer?: TransferRecord;
}

interface ConnectionAttachment {
  role: "sender" | "receiver";
}

export class TransferSession extends DurableObject<Env> {
  async initialize(tokenHash: string, expiresAt: number): Promise<void> {
    const existing = await this.ctx.storage.get<SessionState>("session");
    if (existing) return;
    await this.ctx.storage.put<SessionState>("session", {
      tokenHash,
      createdAt: Date.now(),
      expiresAt,
      uploadCount: 0
    });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async inspect(token: string): Promise<{ expiresAt: number; receiverOnline: boolean; senderOnline: boolean; transfer?: TransferRecord } | null> {
    const state = await this.authorizedState(token);
    if (!state) return null;
    return {
      expiresAt: state.expiresAt,
      receiverOnline: this.ctx.getWebSockets("receiver").length > 0,
      senderOnline: this.ctx.getWebSockets("sender").length > 0,
      transfer: state.transfer
    };
  }

  async beginTransfer(token: string, transfer: TransferRecord): Promise<boolean> {
    const state = await this.authorizedState(token);
    if (!state || state.uploadCount >= 20) return false;
    if (state.transfer?.status === "ready" || state.transfer?.status === "uploading") return false;
    state.transfer = transfer;
    state.uploadCount += 1;
    await this.ctx.storage.put("session", state);
    return true;
  }

  async completeTransfer(token: string, transferId: string, size: number): Promise<TransferRecord | null> {
    const state = await this.authorizedState(token);
    if (!state?.transfer || state.transfer.id !== transferId || state.transfer.status !== "uploading") return null;
    state.transfer.status = "ready";
    state.transfer.size = size;
    await this.ctx.storage.put("session", state);
    this.broadcast({ type: "transfer_ready", transfer: state.transfer });
    return state.transfer;
  }

  async failTransfer(token: string, transferId: string): Promise<void> {
    const state = await this.authorizedState(token);
    if (!state?.transfer || state.transfer.id !== transferId || state.transfer.status !== "uploading") return;
    state.transfer.status = "failed";
    await this.ctx.storage.put("session", state);
  }

  async getTransfer(token: string, transferId: string): Promise<TransferRecord | null> {
    const state = await this.authorizedState(token);
    if (!state?.transfer || state.transfer.id !== transferId) return null;
    if (state.transfer.expiresAt <= Date.now() || state.transfer.status === "expired" || state.transfer.status === "deleted") return null;
    return state.transfer;
  }

  async claimTransfer(token: string, transferId: string): Promise<TransferRecord | null> {
    const state = await this.authorizedState(token);
    const transfer = state?.transfer;
    if (!state || !transfer || transfer.id !== transferId || !canTransition(transfer.status, "claimed")) return null;
    transfer.status = "claimed";
    await this.ctx.storage.put("session", state);
    this.broadcast({ type: "transfer_claimed", transferId });
    return transfer;
  }

  async deleteTransfer(token: string, transferId: string): Promise<TransferRecord | null> {
    const state = await this.authorizedState(token);
    const transfer = state?.transfer;
    if (!state || !transfer || transfer.id !== transferId || transfer.status === "deleted") return null;
    transfer.status = "deleted";
    await this.ctx.storage.put("session", state);
    this.broadcast({ type: "transfer_deleted", transferId });
    return transfer;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const role = url.searchParams.get("role");
    if (role !== "sender" && role !== "receiver") return new Response("Invalid role", { status: 400 });
    const state = await this.authorizedState(token);
    if (!state) return new Response("Session unavailable", { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role } satisfies ConnectionAttachment);
    server.send(JSON.stringify({
      type: "connected",
      role,
      expiresAt: state.expiresAt,
      peerOnline: this.ctx.getWebSockets(role === "sender" ? "receiver" : "sender").length > 0,
      transfer: state.transfer?.status === "ready" ? state.transfer : undefined
    } satisfies SocketMessage));
    this.broadcast({ type: "peer_status", role, online: true }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const parsed = parseClientMessage(message);
    if (!parsed) {
      webSocket.send(JSON.stringify({ type: "error", code: "INVALID_MESSAGE", message: "无法识别的连接消息" } satisfies SocketMessage));
      return;
    }
    if (parsed.type === "ping") webSocket.send(JSON.stringify({ type: "peer_status", role: "sender", online: true } satisfies SocketMessage));
  }

  async webSocketClose(webSocket: WebSocket): Promise<void> {
    const attachment = webSocket.deserializeAttachment() as ConnectionAttachment | null;
    if (attachment) this.broadcast({ type: "peer_status", role: attachment.role, online: false }, webSocket);
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<SessionState>("session");
    if (state?.transfer && state.transfer.status !== "deleted") {
      await this.env.FILES.delete(state.transfer.objectKey);
      state.transfer.status = "expired";
      await this.ctx.storage.put("session", state);
    }
    this.broadcast({ type: "session_expired" });
    for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Session expired");
  }

  private async authorizedState(token: string): Promise<SessionState | null> {
    if (!token) return null;
    const state = await this.ctx.storage.get<SessionState>("session");
    if (!state || state.expiresAt <= Date.now()) return null;
    const candidate = await hashToken(token);
    return constantTimeEqual(candidate, state.tokenHash) ? state : null;
  }

  private broadcast(message: SocketMessage, except?: WebSocket): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except && socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }
}
