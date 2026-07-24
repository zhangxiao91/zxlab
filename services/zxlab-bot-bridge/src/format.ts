import type { SignalBriefing, SignalItem } from "./signal.js";

const MAX_CHARS = 7000;

export function formatLatestSignal(briefing: SignalBriefing): string {
  const lines = [
    briefing.title || `ZX Signal｜${briefing.date}`,
    `日期：${briefing.date}　来源：${briefing.dataOrigin === "real" ? "真实候选" : briefing.dataOrigin ?? "未知"}`,
    "",
    briefing.summary,
  ];
  for (const [index, item] of briefing.items.entries()) {
    lines.push("", `${index + 1}. ${item.title}`, item.summary);
    if (item.whyItMatters) lines.push(`影响：${item.whyItMatters}`);
    if (item.suggestedAction) lines.push(`建议：${item.suggestedAction}`);
  }
  const text = lines.join("\n").trim();
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS - 24).trimEnd()}\n\n（内容已截断）`;
}

export function summarizeSignalItem(item: SignalItem): string {
  return [item.title, item.summary, item.whyItMatters ? `影响：${item.whyItMatters}` : undefined]
    .filter(Boolean).join("\n");
}
