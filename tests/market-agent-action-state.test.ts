import assert from "node:assert/strict";
import test from "node:test";
import {
  completePortfolioWrite,
  portfolioActionLabel,
  portfolioRecheckNotice,
  runExportLabel,
} from "../src/features/market-agent/action-state.ts";

test("portfolio controls label only the action that is actually running", () => {
  assert.equal(portfolioActionLabel("syncing", "sync"), "正在同步");
  assert.equal(portfolioActionLabel("syncing", "stop"), "停止后续使用");
  assert.equal(portfolioActionLabel("stopping", "stop"), "正在停止");
  assert.equal(portfolioActionLabel("purging", "purge"), "正在清除");
});

test("run export has an explicit in-flight label", () => {
  assert.equal(runExportLabel(false), "导出全部记录");
  assert.equal(runExportLabel(true), "导出中");
});

test("a failed runs refresh does not turn a completed portfolio write into an action error", async () => {
  const completion = await completePortfolioWrite(
    async () => ({ detachedRunCount: 0 }),
    async () => { throw new Error("运行记录暂不可用"); },
    () => "已停止后续使用；后续 Run 将保持仅市场模式。",
  );

  assert.deepEqual(completion.writeResult, { detachedRunCount: 0 });
  assert.equal(completion.refreshResult, undefined);
  assert.equal(completion.notice.error, null);
  assert.equal(
    completion.notice.note,
    "已停止后续使用；后续 Run 将保持仅市场模式。运行记录刷新失败：运行记录暂不可用，请手动刷新。",
  );
});

test("a successful portfolio recheck clears a previous portfolio error", () => {
  assert.deepEqual(
    portfolioRecheckNotice("本机快照包含 3 个持仓，可用于同步。"),
    {
      error: null,
      note: "检查完成：本机快照包含 3 个持仓，可用于同步。",
    },
  );
});
