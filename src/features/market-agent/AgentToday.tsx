import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { loadMarketWatchlist } from "../market/watchlist";
import { LocalPortfolioRepository } from "../risk/ledger";
import {
  deleteAgentRun,
  exportAgentRuns,
  getAgentProfile,
  getAgentRuns,
  getPortfolioSnapshotControlState,
  purgePortfolioSnapshotHistory,
  sendRunFeedback,
  startCloseReview,
  stopPortfolioSnapshot,
  syncAgentWatchlist,
  syncPortfolioSnapshot,
  type AgentProfileView,
  type AgentRunMode,
  type AgentRunView,
  type AgentWatchlistItem,
  type PortfolioPurgeScope,
  type PortfolioSnapshotControlState,
} from "./client";
import {
  previewLocalPortfolioSnapshot,
  type LocalPortfolioSnapshotPreview,
} from "./portfolio-snapshot";

const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function AgentToday() {
  const [runs, setRuns] = useState<AgentRunView[]>([]);
  const [profile, setProfile] = useState<AgentProfileView | null>(null);
  const [localWatchlist, setLocalWatchlist] = useState<AgentWatchlistItem[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [portfolioPreview, setPortfolioPreview] =
    useState<LocalPortfolioSnapshotPreview | null>(null);
  const [portfolioState, setPortfolioState] =
    useState<PortfolioSnapshotControlState | null>(null);
  const [portfolioStateLoaded, setPortfolioStateLoaded] = useState(false);
  const [portfolioBusy, setPortfolioBusy] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioNote, setPortfolioNote] = useState<string | null>(null);
  const [purgeScope, setPurgeScope] = useState<PortfolioPurgeScope | null>(
    null,
  );
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    setLocalWatchlist(
      loadMarketWatchlist(window.localStorage).map(
        ({ instrumentId, reason }) => ({ instrumentId, reason }),
      ),
    );
    refreshPortfolioPreview();
    void refresh();
  }, []);
  useEffect(() => {
    if (!rail.current) return;
    const cards = rail.current.querySelectorAll(".agent-run-card");
    gsap.fromTo(
      cards,
      { y: 26, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.65, stagger: 0.08, ease: "power3.out" },
    );
  }, [runs]);
  async function refresh() {
    setLoading(true);
    try {
      const [nextRuns, nextProfile] = await Promise.all([
        getAgentRuns(),
        getAgentProfile(),
      ]);
      setRuns(nextRuns);
      setProfile(nextProfile);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent 暂不可用");
    } finally {
      setLoading(false);
    }
    try {
      setPortfolioState(await getPortfolioSnapshotControlState());
      setPortfolioError(null);
    } catch (cause) {
      setPortfolioState(null);
      setPortfolioError(
        cause instanceof Error ? cause.message : "持仓快照状态暂不可用",
      );
    } finally {
      setPortfolioStateLoaded(true);
    }
  }
  function refreshPortfolioPreview() {
    const preview = previewLocalPortfolioSnapshot(
      new LocalPortfolioRepository(window.localStorage),
    );
    setPortfolioPreview(preview);
    return preview;
  }
  async function syncLocalPortfolioSnapshot() {
    const preview = refreshPortfolioPreview();
    if (!preview.upload) {
      setPortfolioError(preview.issues[0] ?? "本机持仓快照尚不能同步。");
      return;
    }
    setPortfolioBusy(true);
    try {
      const nextState = await syncPortfolioSnapshot(preview.upload);
      setPortfolioState(nextState);
      setPortfolioError(null);
      setPortfolioNote(
        `已同步 ${preview.positionCount} 个持仓；将在 ${date(preview.upload.expiresAt)} 后自动失效。`,
      );
    } catch (cause) {
      setPortfolioError(
        cause instanceof Error ? cause.message : "持仓快照同步失败",
      );
    } finally {
      setPortfolioBusy(false);
    }
  }
  async function stopUsingPortfolioSnapshot() {
    const snapshot = portfolioState?.snapshot;
    if (!snapshot) return;
    setPortfolioBusy(true);
    try {
      const nextState = await stopPortfolioSnapshot(snapshot.id);
      setPortfolioState(nextState);
      setRuns(await getAgentRuns());
      setPortfolioError(null);
      setPortfolioNote(
        nextState.detachedRunCount
          ? `已停止后续使用，并将 ${nextState.detachedRunCount} 个排队 Run 切回仅市场模式。`
          : "已停止后续使用；后续 Run 将保持仅市场模式。",
      );
    } catch (cause) {
      setPortfolioError(
        cause instanceof Error ? cause.message : "停止使用持仓快照失败",
      );
    } finally {
      setPortfolioBusy(false);
    }
  }
  async function confirmPortfolioPurge() {
    if (!purgeScope) return;
    setPortfolioBusy(true);
    try {
      const nextState = await purgePortfolioSnapshotHistory(purgeScope);
      setPortfolioState(nextState);
      setRuns(await getAgentRuns());
      setPortfolioError(null);
      setPortfolioNote(
        `已清除 ${nextState.snapshots} 份快照及 ${nextState.runs} 条关联 Run；审计墓碑已保留。`,
      );
      setPurgeScope(null);
    } catch (cause) {
      setPortfolioError(
        cause instanceof Error ? cause.message : "清除持仓快照历史失败",
      );
    } finally {
      setPortfolioBusy(false);
    }
  }
  async function confirmWatchlist() {
    if (!localWatchlist.length) {
      setError("Market Center 中没有可同步的观察标的。");
      return;
    }
    setSyncBusy(true);
    try {
      const revision = `browser:${Date.now().toString(36)}`;
      const result = await syncAgentWatchlist(revision, localWatchlist);
      setProfile(result.profile);
      setSetupNote(
        `已确认 ${result.watchlist.items.length} 个标的，revision ${result.watchlist.revision}`,
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "观察列表同步失败");
    } finally {
      setSyncBusy(false);
    }
  }
  async function runReview() {
    if (profile?.bootstrap === "required") {
      setError("请先确认并同步观察列表。");
      return;
    }
    setBusy(true);
    try {
      await startCloseReview();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复盘启动失败");
    } finally {
      setBusy(false);
    }
  }
  async function downloadRuns() {
    try {
      const exported = await exportAgentRuns();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `market-agent-runs-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记录导出失败");
    }
  }
  async function removeRun(run: AgentRunView) {
    if (!window.confirm(`删除 ${date(run.createdAt)} 的复盘记录及其 Evidence？此操作无法恢复。`)) return;
    setDeletingRunId(run.id);
    try {
      await deleteAgentRun(run.id);
      setRuns((current) => current.filter((item) => item.id !== run.id));
      if (activeRun === run.id) setActiveRun(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记录删除失败");
    } finally {
      setDeletingRunId(null);
    }
  }
  const latest = runs[0];
  const events = useMemo(() => latest?.result?.observations ?? [], [latest]);
  return (
    <div className="risk-app agent-app">
      <header className="risk-appbar">
        <a href="/lab" className="risk-brand">
          <span className="risk-brand__mark">Z</span>
          <span>
            <strong>Market Agent</strong>
            <small>Evidence-bound review</small>
          </span>
        </a>
        <nav aria-label="Market Agent 导航">
          <a href="/lab/market">行情中心</a>
          <button className="is-active">Today</button>
          <a href="#runs">Runs</a>
        </nav>
        <div className="risk-appbar__actions">
          <button onClick={() => void refresh()} disabled={loading}>
            {loading ? "读取中" : "刷新"}
          </button>
          <span
            className="agent-health-dot"
            aria-label="Agent health operational"
          />
        </div>
      </header>
      <main className="risk-main agent-main">
        <header className="agent-hero">
          <div>
            <p>个人市场复盘</p>
            <h1>
              把市场事实，<span>留在证据里。</span>
            </h1>
            <span>只读观察、确定性事件和可追溯的运行记录。</span>
          </div>
          <div className="agent-hero__action">
            <span>盘后工作流</span>
            <button onClick={() => void runReview()} disabled={busy}>
              {busy ? "正在排队" : "开始盘后复盘"}
            </button>
            <small>
              {latest ? `最近一次 ${date(latest.updatedAt)}` : "尚未有运行记录"}
            </small>
          </div>
        </header>
        {error && (
          <p className="review-status review-status--warning">{error}</p>
        )}
        {profile?.bootstrap === "required" && (
          <section className="agent-bootstrap" aria-label="观察列表启动">
            <div>
              <p>观察范围尚未确认</p>
              <h2>先确认本机 Market Center 的观察列表。</h2>
              <span>
                只同步标的和关注理由，不上传交易账本；定时工作流只读取这次确认的
                revision。
              </span>
            </div>
            <div className="agent-bootstrap__items">
              {localWatchlist.map((item) => (
                <div key={item.instrumentId}>
                  <code>{item.instrumentId}</code>
                  <span>{item.reason ?? "自选标的"}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => void confirmWatchlist()}
              disabled={syncBusy || !localWatchlist.length}
            >
              {syncBusy
                ? "正在同步"
                : `确认并同步 ${localWatchlist.length} 个标的`}
            </button>
          </section>
        )}
        {setupNote && <p className="agent-setup-note">{setupNote}</p>}
        <section className="agent-portfolio" aria-label="持仓快照">
          <header className="agent-portfolio__header">
            <div>
              <p>持仓快照</p>
              <h2>只把确认后的持仓，用于下一次复盘。</h2>
              <span>
                原始券商文件、账户名称、备注和交易明细始终保留在本机；服务端只接收结构化持仓、汇总现金和失效时间。
              </span>
            </div>
            <a href="/lab/trading?view=positions&action=holdings">
              打开持仓风险台
            </a>
          </header>
          {portfolioError && (
            <p className="review-status review-status--warning">
              {portfolioError}
            </p>
          )}
          {portfolioNote && (
            <p className="agent-portfolio__note">{portfolioNote}</p>
          )}
          <div className="agent-portfolio__grid">
            <article className="agent-portfolio__local">
              <header>
                <div>
                  <span>本机预览</span>
                  <strong>
                    {portfolioPreview?.upload ? "可同步" : "需要处理"}
                  </strong>
                </div>
                <button
                  type="button"
                  onClick={refreshPortfolioPreview}
                  disabled={portfolioBusy}
                >
                  重新检查
                </button>
              </header>
              {portfolioPreview?.upload ? (
                <>
                  <dl>
                    <div>
                      <dt>确认时间</dt>
                      <dd>{date(portfolioPreview.upload.calculatedAt)}</dd>
                    </div>
                    <div>
                      <dt>持仓数量</dt>
                      <dd>{portfolioPreview.positionCount} 个标的</dd>
                    </div>
                    <div>
                      <dt>汇总现金</dt>
                      <dd>{formatCash(portfolioPreview.cash)}</dd>
                    </div>
                    <div>
                      <dt>失效时间</dt>
                      <dd>{date(portfolioPreview.upload.expiresAt)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="agent-portfolio__primary"
                    onClick={() => void syncLocalPortfolioSnapshot()}
                    disabled={portfolioBusy}
                  >
                    {portfolioBusy ? "正在同步" : "同步这份持仓快照"}
                  </button>
                </>
              ) : (
                <div className="agent-portfolio__issues">
                  {portfolioPreview?.issues.map((issue) => <p key={issue}>{issue}</p>)}
                  {!portfolioPreview && <p>正在检查本机已确认的券商持仓快照。</p>}
                </div>
              )}
            </article>
            <article className="agent-portfolio__server">
              <header>
                <div>
                  <span>Agent 使用状态</span>
                  <strong>
                    {!portfolioStateLoaded
                      ? "读取中"
                      : portfolioError
                        ? "状态不可用"
                        : portfolioState?.snapshot
                          ? "持仓感知"
                          : "仅市场"}
                  </strong>
                </div>
                {portfolioState?.snapshot && (
                  <button
                    type="button"
                    className="agent-portfolio__stop"
                    onClick={() => void stopUsingPortfolioSnapshot()}
                    disabled={portfolioBusy}
                  >
                    停止后续使用
                  </button>
                )}
              </header>
              {portfolioState?.snapshot ? (
                <dl>
                  <div>
                    <dt>已同步标的</dt>
                    <dd>{portfolioState.snapshot.positions.length} 个</dd>
                  </div>
                  <div>
                    <dt>服务端失效时间</dt>
                    <dd>{date(portfolioState.snapshot.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>字段状态</dt>
                    <dd>{portfolioState.snapshot.reliable ? "完整" : "受限"}</dd>
                  </div>
                  <div>
                    <dt>当前规则</dt>
                    <dd>{portfolioState.snapshot.rulesVersion}</dd>
                  </div>
                </dl>
              ) : (
                <p className="agent-portfolio__empty">
                  {portfolioError
                    ? "暂时无法确认 Agent 是否正在使用持仓快照；请稍后刷新。"
                    : "后续 Run 将只读取市场证据，不会使用本机持仓。"}
                </p>
              )}
              <div className="agent-portfolio__history">
                <span>
                  历史 {portfolioState?.historicalSnapshotCount ?? 0} 份快照 / {portfolioState?.linkedRunCount ?? 0} 条关联 Run
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => setPurgeScope("expired")}
                    disabled={portfolioBusy || !(portfolioState?.expiredSnapshotCount ?? 0)}
                  >
                    清除已过期
                  </button>
                  <button
                    type="button"
                    onClick={() => setPurgeScope("all")}
                    disabled={portfolioBusy || !(portfolioState?.historicalSnapshotCount ?? 0)}
                  >
                    清除全部历史
                  </button>
                </div>
              </div>
            </article>
          </div>
          {purgeScope && (
            <aside className="agent-portfolio__purge" aria-live="polite">
              <div>
                <strong>确认清除{purgeScope === "expired" ? "已过期" : "全部"}持仓快照历史</strong>
                <p>
                  将删除 {purgeScope === "expired" ? portfolioState?.expiredSnapshotCount ?? 0 : portfolioState?.historicalSnapshotCount ?? 0} 份快照和 {purgeScope === "expired" ? portfolioState?.expiredLinkedRunCount ?? 0 : portfolioState?.linkedRunCount ?? 0} 条关联 Run；此操作不可恢复，审计墓碑会保留。
                </p>
              </div>
              <div>
                <button type="button" onClick={() => setPurgeScope(null)} disabled={portfolioBusy}>
                  取消
                </button>
                <button
                  type="button"
                  className="agent-portfolio__purge-confirm"
                  onClick={() => void confirmPortfolioPurge()}
                  disabled={portfolioBusy}
                >
                  {portfolioBusy ? "正在清除" : "确认清除"}
                </button>
              </div>
            </aside>
          )}
        </section>
        <section className="agent-bento" aria-label="Agent 状态">
          <article className="agent-bento-card agent-bento-card--lead">
            <span>当前状态</span>
            <strong>
              {latest ? statusLabel(latest.status) : "等待第一次运行"}
            </strong>
            <p>
              {latest?.result?.summary ??
                "当可靠的 Market Snapshot 到达后，盘后复盘会在这里留下可追溯结果。"}
            </p>
          </article>
          <article className="agent-bento-card">
            <span>最近运行</span>
            <strong>{latest ? date(latest.createdAt) : "—"}</strong>
            <p>
              {latest?.workflow === "close_review"
                ? "盘后复盘"
                : (latest?.workflow ?? "—")}
            </p>
          </article>
          <article className="agent-bento-card">
            <span>Evidence</span>
            <strong>{latest?.evidenceFingerprint ? "已封存" : "—"}</strong>
            <p className="agent-mono">
              {latest?.evidenceFingerprint?.slice(0, 18) ??
                "等待 sealed bundle"}
            </p>
          </article>
          <article className="agent-bento-card">
            <span>运行模式</span>
            <strong>{modeLabel(latest?.result?.mode, latest?.portfolioSnapshotId)}</strong>
            <p>{modeDescription(latest?.result?.mode, latest?.portfolioSnapshotId)}</p>
          </article>
          <article className="agent-bento-card agent-bento-card--accent">
            <span>观察事件</span>
            <strong>{events.length}</strong>
            <p>只显示服务端确定性结果。</p>
          </article>
        </section>
        <section className="agent-desire">
          <div className="agent-pin">
            <p>证据链</p>
            <h2>每个结论都能回到一条事实。</h2>
            <span>Bundle 封存后，叙事只能读取，不能改写。</span>
          </div>
          <div className="agent-event-stack">
            {events.length ? (
              events.map((event) => (
                <article className="agent-run-card" key={event.id}>
                  <div>
                    <span
                      className={`agent-observation agent-observation--${event.class}`}
                    >
                      {event.class}
                    </span>
                    <time>{latest ? date(latest.updatedAt) : "—"}</time>
                  </div>
                  <h3>{event.title}</h3>
                  <p>{event.explanation}</p>
                  <button
                    onClick={() =>
                      setActiveRun(activeRun === event.id ? null : event.id)
                    }
                  >
                    {activeRun === event.id ? "收起 Evidence" : "查看 Evidence"}
                  </button>
                  {activeRun === event.id && (
                    <div className="agent-evidence-row">
                      {event.evidenceIds.map((id) => (
                        <code key={id}>{id}</code>
                      ))}
                    </div>
                  )}
                </article>
              ))
            ) : (
              <article className="agent-empty">
                暂无可展示事件。运行一次盘后复盘后，Evidence 会在这里展开。
              </article>
            )}
          </div>
        </section>
        <section className="agent-runs" id="runs">
          <header>
            <div>
              <p>运行记录</p>
              <h2>Runs 保留事实，反馈只改变下一次排序。</h2>
            </div>
            <div className="agent-runs__actions">
              <button onClick={() => void downloadRuns()} disabled={!runs.length}>
                导出全部记录
              </button>
              <button onClick={() => void runReview()} disabled={busy}>
                {busy ? "排队中" : "再次复盘"}
              </button>
            </div>
          </header>
          <div className="agent-run-list">
            {runs.length ? (
              runs.slice(0, 8).map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onFeedback={async (value) => {
                    try {
                      await sendRunFeedback(run.id, value);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : "反馈未保存",
                      );
                    }
                  }}
                  onDelete={() => void removeRun(run)}
                  deleting={deletingRunId === run.id}
                />
              ))
            ) : (
              <p className="agent-empty">
                还没有 Run。这里不会展示未经 Evidence 支撑的模型正文。
              </p>
            )}
          </div>
        </section>
      </main>
      <footer className="risk-footer">
        <span>zxlab / agent</span>
        <p>Market Agent 只读市场事实，不连接交易执行。</p>
        <a href="/lab/market">Market Center</a>
      </footer>
    </div>
  );
}

function RunRow({
  run,
  onFeedback,
  onDelete,
  deleting,
}: {
  run: AgentRunView;
  onFeedback: (
    value: "helpful" | "fact_error" | "missing_factor",
  ) => Promise<void>;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <article className="agent-run-row">
      <div>
        <span className={`agent-status agent-status--${run.status}`}>
          {statusLabel(run.status)}
        </span>
        <time>{date(run.createdAt)}</time>
        <span className="agent-run-mode">
          {modeLabel(run.result?.mode, run.portfolioSnapshotId)}
        </span>
      </div>
      <div>
        <strong>{run.result?.headline ?? "Deterministic close review"}</strong>
        <p>{run.result?.summary ?? "Evidence 正在收集或等待上游数据。"}</p>
      </div>
      <div className="agent-feedback">
        <button title="有帮助" onClick={() => void onFeedback("helpful")}>
          有帮助
        </button>
        <button title="事实错误" onClick={() => void onFeedback("fact_error")}>
          事实错误
        </button>
        <button
          title="缺少因素"
          onClick={() => void onFeedback("missing_factor")}
        >
          缺少因素
        </button>
        <button title="删除本次记录" onClick={onDelete} disabled={deleting}>
          {deleting ? "删除中" : "删除"}
        </button>
      </div>
    </article>
  );
}
function statusLabel(status: string) {
  return (
    (
      {
        queued: "排队中",
        collecting: "收集事实",
        evidence_sealed: "Evidence 已封存",
        generating: "生成中",
        validating: "校验中",
        success: "完成",
        partial: "部分完成",
        failed: "失败",
        retry_wait: "等待重试",
      } as Record<string, string>
    )[status] ?? status
  );
}

function modeLabel(
  mode?: AgentRunMode,
  portfolioSnapshotId?: string | null,
) {
  if (mode === "portfolio-aware") return "持仓感知";
  if (mode === "market-only") return "仅市场";
  return portfolioSnapshotId ? "待持仓校验" : "待市场校验";
}

function modeDescription(
  mode?: AgentRunMode,
  portfolioSnapshotId?: string | null,
) {
  if (mode === "portfolio-aware") {
    return "行情和持仓快照均满足可靠性条件。";
  }
  if (mode === "market-only") {
    return "本次未产生可靠持仓影响结论。";
  }
  return portfolioSnapshotId
    ? "已绑定持仓快照，等待行情与字段校验。"
    : "未绑定持仓快照，等待市场事实收集。";
}

function formatCash(value: number | null) {
  return value === null
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
        maximumFractionDigits: 2,
      }).format(value);
}
