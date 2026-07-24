export type CommandName = "help" | "status" | "reset";

export function parseCommand(text: string): CommandName | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized === "/help") return "help";
  if (normalized === "/status") return "status";
  if (normalized === "/reset") return "reset";
  return undefined;
}

export function helpText(): string {
  return ["可用命令：", "/help 查看帮助", "/status 查看运行状态", "/reset 清空对话历史"].join("\n");
}
