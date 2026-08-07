import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { loadMarketWatchlist } from "../market/watchlist";
import {
  deleteAgentRun,
  exportAgentRuns,
  getAgentProfile,
  getAgentRuns,
  sendRunFeedback,
  startCloseReview,
  syncAgentWatchlist,
  type AgentProfileView,
  type AgentRunView,
  type AgentWatchlistItem,
} from "./client";

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
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    setLocalWatchlist(
      loadMarketWatchlist(window.localStorage).map(
        ({ instrumentId, reason }) => ({ instrumentId, reason }),
      ),
    );
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
