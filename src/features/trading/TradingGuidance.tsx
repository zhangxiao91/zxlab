import type { TradingReviewMode, TradingTarget, TradingView } from "./route";

const entries: Array<{ id: string; label: string; target: TradingTarget }> = [
  { id: "transactions", label: "导入交易 CSV", target: { view: "activity", action: "import" } },
  { id: "holdings", label: "导入券商持仓", target: { view: "positions", action: "holdings" } },
  { id: "market", label: "查看行情", target: { view: "market" } },
  { id: "risk-review", label: "账户复盘", target: { view: "review", mode: "risk" } },
  { id: "market-review", label: "盘后市场复盘", target: { view: "review", mode: "market" } },
];

export default function TradingGuidance({ active, reviewMode, onNavigate }: { active: TradingView; reviewMode: TradingReviewMode; onNavigate: (target: TradingTarget) => void }) {
  return <section className="trading-guidance" aria-label="交易快捷入口">
    <div className="trading-guidance__lead"><span>下一步</span><strong>交易工作流</strong></div>
    <div className="trading-guidance__actions">
      {entries.map((entry) => {
        const isActive = entry.target.view === active && (entry.target.view !== "review" || entry.target.mode === reviewMode);
        return <button key={entry.id} type="button" className={isActive ? "is-active" : ""} onClick={() => onNavigate(entry.target)}>{entry.label}</button>;
      })}
    </div>
  </section>;
}
