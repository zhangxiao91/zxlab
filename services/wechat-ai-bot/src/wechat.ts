import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import qrcode from "qrcode-terminal";
import { MessageType, WeChatClient, type WeixinMessage } from "wechat-ilink-client";
import { errorMessage, logger } from "./logger.js";

interface SavedCredentials {
  token: string;
  accountId: string;
  baseUrl?: string;
}

export interface IncomingTextMessage {
  platformMessageId: string;
  userId: string;
  text: string;
  contextToken: string;
}

export type IncomingHandler = (message: IncomingTextMessage) => Promise<void>;

function isSavedCredentials(value: unknown): value is SavedCredentials {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.token === "string" && typeof candidate.accountId === "string" &&
    (candidate.baseUrl === undefined || typeof candidate.baseUrl === "string");
}

function deriveMessageId(message: WeixinMessage, userId: string, text: string): string {
  const direct = message.message_id ?? message.client_id ?? message.item_list?.find((item) => item.msg_id)?.msg_id;
  if (direct !== undefined) return String(direct);
  return crypto.createHash("sha256")
    .update([userId, message.session_id ?? "", String(message.create_time_ms ?? ""), text].join("\0"))
    .digest("hex");
}

export class WeChatService {
  private client: WeChatClient | undefined;
  private stopping = false;
  private readonly credentialsFile: string;
  private readonly syncFile: string;

  constructor(private readonly credentialsDir: string, private readonly onText: IncomingHandler) {
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(credentialsDir, 0o700);
    this.credentialsFile = path.join(credentialsDir, "session.json");
    this.syncFile = path.join(credentialsDir, "sync.buf");
  }

  private loadCredentials(): SavedCredentials | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.credentialsFile, "utf8"));
      if (!isSavedCredentials(parsed)) throw new Error("Credential file has an invalid shape");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("wechat_credentials_unavailable", { error: errorMessage(error) });
      }
      return undefined;
    }
  }

  private saveCredentials(credentials: SavedCredentials): void {
    const temporary = `${this.credentialsFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(credentials), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.credentialsFile);
  }

  private clearCredentials(): void {
    for (const file of [this.credentialsFile, this.syncFile]) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.warn("wechat_credential_cleanup_failed", { file: path.basename(file), error: errorMessage(error) });
        }
      }
    }
  }

  private async createClient(): Promise<WeChatClient> {
    const saved = this.loadCredentials();
    if (saved) {
      logger.info("wechat_credentials_loaded", { accountIdPresent: true });
      return new WeChatClient({
        token: saved.token,
        accountId: saved.accountId,
        ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
      });
    }

    const client = new WeChatClient();
    logger.info("wechat_login_required");
    const result = await client.login({
      onQRCode(url) {
        logger.info("wechat_qr_ready", { instruction: "Scan the QR code shown in the container logs" });
        qrcode.generate(url, { small: true });
      },
      onStatus(status) {
        logger.info("wechat_login_status", { status });
      },
    });
    if (!result.connected || !result.botToken || !result.accountId) {
      throw new Error(`WeChat login failed: ${result.message}`);
    }
    this.saveCredentials({
      token: result.botToken,
      accountId: result.accountId,
      ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
    });
    logger.info("wechat_login_succeeded", { accountIdPresent: true });
    return client;
  }

  async run(): Promise<void> {
    while (!this.stopping) {
      let sessionExpired = false;
      try {
        const client = await this.createClient();
        this.client = client;
        client.on("error", (error) => logger.warn("wechat_connection_error", { error: errorMessage(error) }));
        client.on("sessionExpired", () => {
          sessionExpired = true;
          logger.warn("wechat_session_expired");
          client.stop();
        });
        client.on("message", (message) => this.handleMessage(message));
        logger.info("wechat_monitor_started");
        await client.start({
          loadSyncBuf: () => {
            try { return fs.readFileSync(this.syncFile, "utf8"); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw error;
            }
          },
          saveSyncBuf: (buf) => fs.writeFileSync(this.syncFile, buf, { encoding: "utf8", mode: 0o600 }),
        });
        if (sessionExpired) this.clearCredentials();
      } catch (error) {
        if (this.stopping) break;
        logger.error("wechat_monitor_stopped_unexpectedly", { error: errorMessage(error) });
      } finally {
        this.client = undefined;
      }
      if (!this.stopping) {
        logger.info("wechat_reconnect_scheduled", { delayMs: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  private handleMessage(message: WeixinMessage): void {
    if (message.message_type !== MessageType.USER || !message.from_user_id || !message.context_token) return;
    const hasTextItem = message.item_list?.some((item) => item.type === 1 && item.text_item?.text !== undefined);
    if (!hasTextItem) {
      logger.info("wechat_non_text_message_ignored", { userIdPresent: true });
      return;
    }
    const text = WeChatClient.extractText(message);
    const incoming: IncomingTextMessage = {
      platformMessageId: deriveMessageId(message, message.from_user_id, text),
      userId: message.from_user_id,
      text,
      contextToken: message.context_token,
    };
    void this.onText(incoming).catch((error) => {
      logger.error("incoming_message_handler_failed", { error: errorMessage(error) });
    });
  }

  async sendText(userId: string, text: string, contextToken: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("WeChat client is not connected");
    await client.sendText(userId, text, contextToken);
  }

  stop(): void {
    this.stopping = true;
    this.client?.stop();
  }
}
