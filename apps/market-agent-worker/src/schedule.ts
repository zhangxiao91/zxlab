import type { AgentWorkflow } from "@zxlab/market-agent-schema";
import type { MarketDay, TradingCalendar } from "@zxlab/market-schema";

export type ScheduleDecision = { workflow: Extract<AgentWorkflow, "morning_brief" | "close_review">; marketDate: string; decision: "run" | "skipped" | "blocked"; calendar: MarketDay; reason: string; };

export function scheduledWorkflowAt(date: Date): Extract<AgentWorkflow, "morning_brief" | "close_review"> | null {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (hour === 8 && minute === 45) return "morning_brief";
  if (hour === 15 && minute === 20) return "close_review";
  return null;
}

export function shanghaiDate(date: Date): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }

export async function decideScheduledWorkflow(workflow: Extract<AgentWorkflow, "morning_brief" | "close_review">, date: Date, calendar: TradingCalendar): Promise<ScheduleDecision> {
  const marketDate = shanghaiDate(date);
  let marketDay: MarketDay;
  try { marketDay = await calendar.getMarketDay("CN", marketDate); }
  catch { marketDay = { status: "unknown", source: "calendar-error", reliable: false, warnings: ["calendar lookup failed"] }; }
  if (marketDay.status === "trading_day" && marketDay.reliable) return { workflow, marketDate, decision: "run", calendar: marketDay, reason: "TRADING_DAY" };
  if (marketDay.status === "holiday") return { workflow, marketDate, decision: "skipped", calendar: marketDay, reason: "MARKET_CLOSED" };
  return { workflow, marketDate, decision: "blocked", calendar: marketDay, reason: "CALENDAR_UNAVAILABLE" };
}
