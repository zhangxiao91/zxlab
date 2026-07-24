import path from "node:path";

export interface Config {
  openaiApiKey: string;
  openaiBaseUrl?: string;
  openaiModel: string;
  systemPromptFile: string;
  databasePath: string;
  credentialsDir: string;
  bootstrapOwnerOnFirstMessage: boolean;
  allowedUserId?: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  contextMaxMessages: number;
  contextMaxChars: number;
  outgoingMessageMaxChars: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integer(name: string, fallback: number, minimum: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(cwd = process.cwd()): Config {
  const baseUrl = optional("OPENAI_BASE_URL");
  const allowedUserId = optional("ALLOWED_USER_ID");
  return {
    openaiApiKey: required("OPENAI_API_KEY"),
    ...(baseUrl ? { openaiBaseUrl: baseUrl } : {}),
    openaiModel: required("OPENAI_MODEL"),
    systemPromptFile: path.resolve(cwd, optional("SYSTEM_PROMPT_FILE") ?? "./persona.md"),
    databasePath: path.resolve(cwd, optional("DATABASE_PATH") ?? "./data/bot.db"),
    credentialsDir: path.resolve(cwd, optional("WECHAT_CREDENTIALS_DIR") ?? "./credentials"),
    bootstrapOwnerOnFirstMessage: boolean("BOOTSTRAP_OWNER_ON_FIRST_MESSAGE", true),
    ...(allowedUserId ? { allowedUserId } : {}),
    llmTimeoutMs: integer("LLM_TIMEOUT_MS", 60_000, 1_000),
    llmMaxRetries: integer("LLM_MAX_RETRIES", 2, 0),
    contextMaxMessages: integer("CONTEXT_MAX_MESSAGES", 30, 1),
    contextMaxChars: integer("CONTEXT_MAX_CHARS", 30_000, 1),
    outgoingMessageMaxChars: integer("OUTGOING_MESSAGE_MAX_CHARS", 1_800, 1),
  };
}
