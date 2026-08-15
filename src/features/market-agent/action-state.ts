export type PortfolioAction = "syncing" | "stopping" | "purging";
export type PortfolioControl = "sync" | "stop" | "purge";

export interface PortfolioNotice {
  error: string | null;
  note: string;
}

export interface PortfolioWriteCompletion<WriteResult, RefreshResult> {
  writeResult: WriteResult;
  refreshResult?: RefreshResult;
  notice: PortfolioNotice;
}

export function portfolioActionLabel(
  action: PortfolioAction | null,
  control: PortfolioControl,
): string {
  if (control === "sync") return action === "syncing" ? "正在同步" : "同步这份持仓快照";
  if (control === "stop") return action === "stopping" ? "正在停止" : "停止后续使用";
  return action === "purging" ? "正在清除" : "确认清除";
}

export function runExportLabel(busy: boolean): string {
  return busy ? "导出中" : "导出全部记录";
}

export function completedPortfolioWriteNotice(
  successNote: string,
  refreshFailure?: unknown,
): PortfolioNotice {
  if (refreshFailure === undefined) return { error: null, note: successNote };
  const message = refreshFailure instanceof Error
    ? refreshFailure.message
    : "运行记录暂不可用";
  return {
    error: null,
    note: `${successNote}运行记录刷新失败：${message}，请手动刷新。`,
  };
}

export async function completePortfolioWrite<WriteResult, RefreshResult>(
  write: () => Promise<WriteResult>,
  refreshRuns: () => Promise<RefreshResult>,
  successNote: (result: WriteResult) => string,
): Promise<PortfolioWriteCompletion<WriteResult, RefreshResult>> {
  const writeResult = await write();
  const note = successNote(writeResult);
  try {
    return {
      writeResult,
      refreshResult: await refreshRuns(),
      notice: completedPortfolioWriteNotice(note),
    };
  } catch (refreshFailure) {
    return {
      writeResult,
      notice: completedPortfolioWriteNotice(note, refreshFailure),
    };
  }
}

export function portfolioRecheckNotice(summary: string): PortfolioNotice {
  return {
    error: null,
    note: `检查完成：${summary}`,
  };
}
