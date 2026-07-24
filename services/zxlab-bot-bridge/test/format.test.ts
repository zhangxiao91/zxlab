import test from "node:test";
import assert from "node:assert/strict";
import { formatLatestSignal } from "../src/format.js";

test("formats a briefing for chat", () => {
  const text = formatLatestSignal({
    id: "briefing-1", date: "2026-07-22", status: "ready", title: "ZX Signal｜2026-07-22",
    summary: "今日摘要", dataOrigin: "real", items: [{
      title: "一条变化", category: "ai-engineering", summary: "事实摘要", whyItMatters: "与项目相关", suggestedAction: "做验证",
    }],
  });
  assert.match(text, /ZX Signal｜2026-07-22/);
  assert.match(text, /影响：与项目相关/);
  assert.match(text, /建议：做验证/);
});
