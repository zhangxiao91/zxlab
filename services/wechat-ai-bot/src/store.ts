import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  boundNow: boolean;
  ownerUserId?: string;
}

interface MessageRow {
  role: ConversationRole;
  content: string;
}

export class Store {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    const dataDirectory = path.dirname(databasePath);
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDirectory, 0o700);
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_message_id TEXT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_platform_message_id
        ON messages(platform_message_id)
        WHERE platform_message_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_messages_user_id_id
        ON messages(user_id, id);

      CREATE TABLE IF NOT EXISTS processed_messages (
        platform_message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
    `);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  authorizeUser(userId: string, allowedUserId: string | undefined, bootstrap: boolean): AuthorizationResult {
    if (allowedUserId) {
      return { allowed: userId === allowedUserId, boundNow: false, ownerUserId: allowedUserId };
    }

    return this.db.transaction((): AuthorizationResult => {
      const existing = this.getSetting("owner_user_id");
      if (existing) return { allowed: userId === existing, boundNow: false, ownerUserId: existing };
      if (!bootstrap) return { allowed: false, boundNow: false };

      const now = new Date().toISOString();
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('owner_user_id', ?, ?)
      `).run(userId, now);
      const owner = this.getSetting("owner_user_id");
      return {
        allowed: owner === userId,
        boundNow: result.changes === 1 && owner === userId,
        ...(owner ? { ownerUserId: owner } : {}),
      };
    })();
  }

  claimIncomingMessage(platformMessageId: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO processed_messages (platform_message_id, processed_at)
      VALUES (?, ?)
    `).run(platformMessageId, new Date().toISOString());
    return result.changes === 1;
  }

  addUserMessage(platformMessageId: string, userId: string, content: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (platform_message_id, user_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, ?)
    `).run(platformMessageId, userId, content, new Date().toISOString());
    return result.changes === 1;
  }

  addAssistantMessage(userId: string, content: string): void {
    this.db.prepare(`
      INSERT INTO messages (platform_message_id, user_id, role, content, created_at)
      VALUES (NULL, ?, 'assistant', ?, ?)
    `).run(userId, content, new Date().toISOString());
  }

  getRecentMessages(userId: string, maxMessages: number, maxChars: number): ConversationMessage[] {
    const rows = this.db.prepare(`
      SELECT role, content
      FROM messages
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(userId, maxMessages) as MessageRow[];
    const chronological = rows.reverse();
    let totalChars = 0;
    const selected: ConversationMessage[] = [];

    for (let index = chronological.length - 1; index >= 0; index -= 1) {
      const row = chronological[index];
      if (!row) continue;
      const chars = Array.from(row.content);
      const remaining = maxChars - totalChars;
      if (remaining <= 0) break;
      const content = chars.length <= remaining ? row.content : chars.slice(-remaining).join("");
      selected.unshift({ role: row.role, content });
      totalChars += Math.min(chars.length, remaining);
    }
    return selected;
  }

  countMessages(userId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE user_id = ?").get(userId) as { count: number };
    return row.count;
  }

  resetConversation(userId: string): number {
    return this.db.prepare("DELETE FROM messages WHERE user_id = ?").run(userId).changes;
  }

  close(): void {
    this.db.close();
  }
}
