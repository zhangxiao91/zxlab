import { useEffect, useMemo, useRef, useState } from "react";
import { loadRiskDashboard } from "./api";
import { riskMockData } from "./mock";
import type { EvidenceItem, Position, RiskDashboardData, RiskEvent } from "./types";

type View = "dashboard" | "positions" | "activity" | "review" | "settings";

const navItems: Array<{ id: View; label: string }> = [
  { id: "dashboard", label: "总览" },
  { id: "positions", label: "持仓" },
  { id: "activity", label: "记录" },
  { id: "review", label: "复盘" },
  { id: "settings", label: "设置" },
];

const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function Metric({ label, value, note, tone = "neutral" }: { label: string; value: string; note: string; tone?: "neutral" | "danger" | "warning" }) {
  return (
    <article className={`risk-metric risk-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function ReliabilityBand({ data }: { data: RiskDashboardData }) {
  return (
    <div className={`reliability-band ${data.portfolio.reliable ? "is-reliable" : "is-blocked"}`}>
      <span className="reliability-band__signal" aria-hidden="true" />
      <div>
        <strong>{data.portfolio.reliable ? "风险快照可可靠计算" : "精确风险值已暂停"}</strong>
        <p>{data.portfolio.reliable ? "全部报价通过新鲜度与价格质量检查。" : "513100 行情超过 120 秒。旧值保留用于追溯，但不作为可靠风险结论。"}</p>
      </div>
      <span className="reliability-band__time">市场时间 14:32:10</span>
    </div>
  );
}

function ExposureChart({ data }: { data: RiskDashboardData }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    let chart: import("echarts/core").EChartsType | undefined;
    let disposed = false;
    void import("./chart").then(({ createEquityChart }) => {
      if (!ref.current || disposed) return;
      chart = createEquityChart(ref.current, data.equityCurve);
      const resize = () => chart?.resize();
      window.addEventListener("resize", resize);
      (chart as import("echarts/core").EChartsType & { __resize?: () => void }).__resize = resize;
    });
    return () => {
      disposed = true;
      const resize = (chart as (import("echarts/core").EChartsType & { __resize?: () => void }) | undefined)?.__resize;
      if (resize) window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [data]);
  return <div ref={ref} className="exposure-chart" role="img" aria-label="七月账户净值曲线" />;
}

function AlertCard({ event, onEvidence }: { event: RiskEvent; onEvidence: (id: string) => void }) {
  return (
    <article className={`alert-card alert-card--${event.severity}`}>
      <div className="alert-card__top">
        <span className="alert-card__severity">{event.severity}</span>
        <span>{event.triggeredAt.slice(11, 16)}</span>
      </div>
      <h3>{event.title}</h3>
      <p>{event.message}</p>
      <div className="alert-card__evidence">
        {event.evidenceIds.slice(0, 2).map((id) => <button key={id} onClick={() => onEvidence(id)}>{id}</button>)}
      </div>
    </article>
  );
}

function PositionTable({ positions }: { positions: Position[] }) {
  return (
    <div className="position-table-wrap">
      <table className="position-table">
        <thead><tr><th>标的</th><th>现价 / 质量</th><th>数量</th><th>市值</th><th>浮动盈亏</th><th>名义仓位</th><th>有效敞口</th><th>交易计划</th></tr></thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.instrumentId}>
              <td><div className="instrument-cell"><strong>{position.name}</strong><span>{position.instrumentId} · {position.industry}</span></div></td>
              <td><strong>{position.price.toFixed(3)}</strong><span className={`quality-tag quality-tag--${position.quoteQuality}`}>{position.quoteQuality} · {position.quoteTime}</span></td>
              <td>{number.format(position.quantity)}</td>
              <td>{money.format(position.marketValue)}</td>
              <td className={position.unrealizedPnl >= 0 ? "is-positive" : "is-negative"}>{money.format(position.unrealizedPnl)}</td>
              <td>{pct(position.nominalWeight)}</td>
              <td><strong>{pct(position.effectiveExposure)}</strong>{position.leverageMultiplier > 1 && <span className="leverage-mark">×{position.leverageMultiplier}</span>}</td>
              <td><span className={`plan-state plan-state--${position.planStatus}`}>{position.planStatus === "aligned" ? "符合" : position.planStatus === "overweight" ? "超计划" : "缺失"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dashboard({ data, onEvidence, onNavigate }: { data: RiskDashboardData; onEvidence: (id: string) => void; onNavigate: (view: View) => void }) {
  const highEvents = data.riskEvents.filter((event) => event.severity === "high" || event.severity === "critical");
  return (
    <div className="risk-view risk-dashboard">
      <ReliabilityBand data={data} />
      <section className="risk-metric-grid" aria-label="账户风险指标">
        <article className="risk-overview-card">
          <div className="risk-overview-card__head"><span>账户净值</span><span>近 18 日</span></div>
          <strong>{money.format(data.portfolio.netValue)}</strong>
          <p className="is-negative">今日 {money.format(data.portfolio.dayPnl)} · {pct(data.portfolio.dayReturn)}</p>
          <ExposureChart data={data} />
        </article>
        <Metric label="有效总敞口" value={pct(data.portfolio.effectiveExposure)} note="规则上限 120%" tone="danger" />
        <Metric label="风险预算使用" value={pct(data.portfolio.riskBudgetUsed)} note="日亏损预算 2.5%" tone="warning" />
        <Metric label="当前回撤" value={pct(data.portfolio.currentDrawdown)} note={`历史最大 ${pct(data.portfolio.maxDrawdown)}`} tone="warning" />
        <Metric label="可用现金" value={money.format(data.portfolio.cash)} note={`持仓市值 ${money.format(data.portfolio.marketValue)}`} />
      </section>

      <section className="risk-section">
        <header className="risk-section__header"><div><p>需要先处理的事实</p><h2>{highEvents.length} 个高优先级事件正在生效。</h2></div><button onClick={() => onNavigate("activity")}>查看完整时间线</button></header>
        <div className="alert-grid">{highEvents.map((event) => <AlertCard key={event.id} event={event} onEvidence={onEvidence} />)}</div>
      </section>

      <section className="risk-section">
        <header className="risk-section__header"><div><p>仓位与计划</p><h2>杠杆折算后，名义仓位不再代表真实风险。</h2></div><button onClick={() => onNavigate("positions")}>展开持仓</button></header>
        <PositionTable positions={data.positions} />
      </section>

      <section className="review-callout">
        <div><span>收盘复盘</span><h2>让每个结论回到成交、计划、行情和规则。</h2><p>Review Agent 只能阅读 Evidence Pack。它不会计算盈亏，也不能修改任何账本或计划。</p></div>
        <button onClick={() => onNavigate("review")}>打开今日复盘</button>
      </section>
    </div>
  );
}

function Positions({ data }: { data: RiskDashboardData }) {
  return <div className="risk-view"><header className="view-intro"><p>真实持仓快照</p><h2>同时看名义权重与杠杆后的有效敞口。</h2><span>行情过期时，行级数值保留但标记为不可可靠。</span></header><PositionTable positions={data.positions} /><div className="position-detail-grid">{data.positions.map((position) => <article key={position.instrumentId}><div><span>{position.symbol}</span><span>{position.industry}</span></div><h3>{position.name}</h3><p>{position.themes.join(" / ")}</p><dl><div><dt>平均成本</dt><dd>{position.averageCost.toFixed(3)}</dd></div><div><dt>当日盈亏</dt><dd className="is-negative">{money.format(position.dayPnl)}</dd></div><div><dt>杠杆倍数</dt><dd>{position.leverageMultiplier.toFixed(1)}×</dd></div><div><dt>风险事件</dt><dd>{position.riskEventIds.length}</dd></div></dl></article>)}</div></div>;
}

function Activity({ data, onEvidence }: { data: RiskDashboardData; onEvidence: (id: string) => void }) {
  return <div className="risk-view"><header className="view-intro"><p>不可变操作记录</p><h2>把行为放回它发生时的风险状态。</h2><span>更正通过新事件完成，历史成交和计划版本不会被覆盖。</span></header><div className="activity-list">{data.activity.map((item) => <button key={item.id} className={`activity-row activity-row--${item.tone}`} onClick={() => onEvidence(item.evidenceId)}><time>{item.time}</time><span className="activity-row__marker"/><div><span>{item.type}</span><h3>{item.title}</h3><p>{item.detail}</p></div><code>{item.evidenceId}</code></button>)}</div></div>;
}

function Review({ data, onEvidence }: { data: RiskDashboardData; onEvidence: (id: string) => void }) {
  const review = data.review;
  return <div className="risk-view"><header className="view-intro review-intro"><div><p>结构化收盘复盘</p><h2>解释风险，不替你下结论。</h2><span>2026 年 7 月 18 日 · {review.mode === "mock" ? "Mock Agent" : "OpenAI Agent"}</span></div><button>重新生成 Evidence Pack</button></header><section className="review-summary"><span>今日摘要</span><p>{review.summary}</p></section><div className="review-columns"><section><header><span>主要风险</span><strong>{review.mainRisks.length}</strong></header>{review.mainRisks.map((risk) => <article key={risk.title} className={`review-risk review-risk--${risk.severity}`}><h3>{risk.title}</h3><p>{risk.explanation}</p><div>{risk.evidenceIds.map((id) => <button key={id} onClick={() => onEvidence(id)}>{id}</button>)}</div></article>)}</section><section><header><span>计划与操作偏离</span><strong>{review.planViolations.length + review.operationReview.length}</strong></header>{review.planViolations.map((item) => <article key={item.title}><span>计划偏离</span><h3>{item.title}</h3><p>{item.detail}</p><div>{item.evidenceIds.map((id) => <button key={id} onClick={() => onEvidence(id)}>{id}</button>)}</div></article>)}{review.operationReview.map((item) => <article key={item.observation}><span>{item.category}</span><p>{item.observation}</p><div>{item.evidenceIds.map((id) => <button key={id} onClick={() => onEvidence(id)}>{id}</button>)}</div></article>)}</section></div><div className="review-footer-grid"><section><span>反事实问题</span>{review.counterfactuals.map((item) => <p key={item}>{item}</p>)}</section><section><span>未知与限制</span>{[...review.unknowns, ...review.limitations].map((item) => <p key={item}>{item}</p>)}</section></div></div>;
}

function Settings({ data }: { data: RiskDashboardData }) {
  const [mockMode, setMockMode] = useState(true);
  return <div className="risk-view"><header className="view-intro"><p>只读系统边界</p><h2>规则、来源与标的口径都应显式可见。</h2><span>MVP 不持有下单、撤单或资金操作权限。</span></header><div className="settings-grid"><section><h3>风险规则</h3>{[["最大有效敞口", "120%"], ["单标的上限", "35%"], ["主题集中度", "45%"], ["日亏损预算", "2.5%"]].map(([label, value]) => <div className="setting-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</section><section><h3>数据源</h3>{data.sourceHealth.map((source) => <div className="setting-row" key={source.name}><span><i className={`source-dot source-dot--${source.status}`}/>{source.name}</span><strong>{source.freshness}</strong></div>)}</section><section><h3>运行模式</h3><button className="mode-toggle" aria-pressed={mockMode} onClick={() => setMockMode(!mockMode)}><span><strong>{mockMode ? "Mock Provider" : "真实 Provider"}</strong><small>{mockMode ? "本地可重复场景" : "需要私有后端配置"}</small></span><i/></button><div className="setting-row"><span>LLM 模式</span><strong>失败时自动降级</strong></div></section><section className="readonly-card"><span>权限声明</span><h3>Read only, by construction.</h3><p>Agent 工具与账户 API 均不包含写入订单的能力。外部新闻、公告和研报作为不可信文本处理。</p></section></div></div>;
}

function EvidenceDrawer({ evidence, onClose }: { evidence: EvidenceItem | undefined; onClose: () => void }) {
  if (!evidence) return null;
  return <div className="evidence-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title"><button className="evidence-close" onClick={onClose} aria-label="关闭证据详情">关闭</button><span>{evidence.type}</span><h2 id="evidence-title">{evidence.title}</h2><p>{evidence.id}</p><dl><div><dt>时间</dt><dd>{evidence.timestamp}</dd></div><div><dt>来源</dt><dd>{evidence.source}</dd></div>{Object.entries(evidence.payload).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl><footer>此记录只读。风险结论引用该 ID，而不是复制后失去来源的自然语言。</footer></aside></div>;
}

export default function RiskWorkbench() {
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState(riskMockData);
  const [mode, setMode] = useState<"api" | "mock">("mock");
  const [selectedEvidence, setSelectedEvidence] = useState<string>();
  useEffect(() => { void loadRiskDashboard().then((result) => { setData(result.data); setMode(result.mode); }); }, []);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cleanup = () => {};
    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([gsapModule, triggerModule]) => {
      const gsap = gsapModule.default;
      const ScrollTrigger = triggerModule.ScrollTrigger;
      gsap.registerPlugin(ScrollTrigger);
      const context = gsap.context(() => {
        gsap.from(".risk-hero > div:first-child > *", { y: 42, opacity: 0, duration: 1, stagger: 0.1, ease: "power3.out" });
        gsap.utils.toArray<HTMLElement>(".alert-card").forEach((card, index) => {
          gsap.fromTo(card, { y: 70 + index * 16, scale: 0.94, opacity: 0.25 }, { y: 0, scale: 1, opacity: 1, ease: "none", scrollTrigger: { trigger: card, start: "top 92%", end: "top 58%", scrub: 0.7 } });
        });
        if (window.matchMedia("(min-width: 64rem)").matches) {
          gsap.utils.toArray<HTMLElement>(".risk-section__header").forEach((heading) => {
            ScrollTrigger.create({ trigger: heading.parentElement, start: "top 18%", end: "bottom 45%", pin: heading, pinSpacing: false });
          });
        }
      });
      cleanup = () => context.revert();
      ScrollTrigger.refresh();
    });
    return () => cleanup();
  }, [view]);
  const evidence = useMemo(() => data.evidence.find((item) => item.id === selectedEvidence), [data, selectedEvidence]);
  const openEvidence = (id: string) => { const exact = data.evidence.find((item) => item.id === id); if (exact) setSelectedEvidence(id); else setSelectedEvidence(data.evidence.find((item) => id.includes(item.id.split(":")[0]))?.id); };

  return (
    <div className="risk-app">
      <header className="risk-appbar">
        <a href="/lab" className="risk-brand" aria-label="返回实验室"><span className="risk-brand__mark">Z</span><span><strong>持仓风险台</strong><small>Evidence before narrative</small></span></a>
        <nav aria-label="风险工作台导航">{navItems.map((item) => <button key={item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}</nav>
        <div className="risk-appbar__status"><span className={mode === "api" ? "is-live" : "is-mock"}/><div><strong>{mode === "api" ? "私有 API" : "Mock 演示"}</strong><small>收到于 14:32:11</small></div></div>
      </header>

      <main className="risk-main">
        <header className="risk-hero">
          <div><p>个人持仓风险监控与操作复盘</p><h1>先把风险算清楚，<br/><span>再解释今天发生了什么。</span></h1></div>
          <div className="risk-hero__aside"><p>只读系统</p><strong>{data.riskEvents.filter((event) => event.status === "active").length}</strong><span>个活跃风险事件</span><small>数据、规则与解释保持分层</small></div>
        </header>

        {view === "dashboard" && <Dashboard data={data} onEvidence={openEvidence} onNavigate={setView} />}
        {view === "positions" && <Positions data={data} />}
        {view === "activity" && <Activity data={data} onEvidence={openEvidence} />}
        {view === "review" && <Review data={data} onEvidence={openEvidence} />}
        {view === "settings" && <Settings data={data} />}
      </main>

      <footer className="risk-footer"><span>zxlab / risk</span><p>确定性计算来自 Risk Engine。自然语言仅用于解释，不构成投资建议。</p><a href="/lab">返回 Lab</a></footer>
      <EvidenceDrawer evidence={evidence} onClose={() => setSelectedEvidence(undefined)} />
    </div>
  );
}
