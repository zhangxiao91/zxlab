import "dotenv/config";
import { helpText, parseCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { LlmClient } from "./llm.js";
import { errorMessage, logger, maskUserId } from "./logger.js";
import { PerKeyQueue } from "./queue.js";
import { Store } from "./store.js";
import { splitText } from "./text-splitter.js";
import { WeChatService, type IncomingTextMessage } from "./wechat.js";

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const queue = new PerKeyQueue();
  const llm = new LlmClient({
    apiKey: config.openaiApiKey,
    ...(config.openaiBaseUrl ? { baseUrl: config.openaiBaseUrl } : {}),
    model: config.openaiModel,
    systemPromptFile: config.systemPromptFile,
    timeoutMs: config.llmTimeoutMs,
    maxRetries: config.llmMaxRetries,
  });

  let shuttingDown = false;
  let wechat: WeChatService;

  const sendReply = async (message: IncomingTextMessage, text: string): Promise<void> => {
    const chunks = splitText(text, config.outgoingMessageMaxChars);
    for (const chunk of chunks) {
      try {
        await wechat.sendText(message.userId, chunk, message.contextToken);
      } catch (error) {
        logger.error("wechat_message_send_failed", {
          userId: maskUserId(message.userId),
          chunkChars: Array.from(chunk).length,
          error: errorMessage(error),
        });
        throw error;
      }
    }
  };

  const processMessage = async (message: IncomingTextMessage): Promise<void> => {
    const command = parseCommand(message.text);
    if (command === "help") {
      await sendReply(message, helpText());
      return;
    }
    if (command === "status") {
      const recentContextCount = store.getRecentMessages(
        message.userId,
        config.contextMaxMessages,
        config.contextMaxChars,
      ).length;
      await sendReply(message, [
        "运行状态：正常",
        `当前模型：${config.openaiModel}`,
        `近期上下文消息：${recentContextCount} 条`,
      ].join("\n"));
      return;
    }
    if (command === "reset") {
      store.resetConversation(message.userId);
      await sendReply(message, "对话历史已清空，所有者绑定和微信登录状态保持不变。");
      return;
    }

    store.addUserMessage(message.platformMessageId, message.userId, message.text);
    const context = store.getRecentMessages(
      message.userId,
      config.contextMaxMessages,
      config.contextMaxChars,
    );
    let response: string;
    try {
      response = await llm.complete(context);
    } catch (error) {
      logger.error("llm_request_failed", {
        userId: maskUserId(message.userId),
        error: errorMessage(error),
      });
      await sendReply(message, "模型服务暂时不可用，请稍后重试。");
      return;
    }
    store.addAssistantMessage(message.userId, response);
    await sendReply(message, response);
  };

  const onText = async (message: IncomingTextMessage): Promise<void> => {
    const authorization = store.authorizeUser(
      message.userId,
      config.allowedUserId,
      config.bootstrapOwnerOnFirstMessage,
    );
    if (!authorization.allowed) {
      logger.warn("message_rejected_non_owner", { userId: maskUserId(message.userId) });
      return;
    }
    if (authorization.boundNow) {
      logger.info("owner_bound", { userId: maskUserId(message.userId) });
    }
    if (!store.claimIncomingMessage(message.platformMessageId)) {
      logger.info("duplicate_message_ignored", { platformMessageIdPresent: true });
      return;
    }
    logger.info("message_received", {
      userId: maskUserId(message.userId),
      contentChars: Array.from(message.text).length,
    });
    queue.enqueue(message.userId, () => processMessage(message));
  };

  wechat = new WeChatService(config.credentialsDir, onText);
  logger.info("database_initialized", { databasePath: config.databasePath });
  logger.info("bot_started", { model: config.openaiModel });

  const runPromise = wechat.run();
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_started", { signal });
    wechat.stop();
    await runPromise;
    await queue.drain();
    store.close();
    logger.info("shutdown_completed");
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await runPromise;
  if (!shuttingDown) {
    await queue.drain();
    store.close();
  }
}

main().catch((error) => {
  logger.error("bot_fatal", { error: errorMessage(error) });
  process.exitCode = 1;
});
