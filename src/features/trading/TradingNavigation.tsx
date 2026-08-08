import type { ReactNode } from "react";
import type { TradingView } from "./route";

const navigationItems: Array<{ id: TradingView; label: string }> = [
  { id: "overview", label: "总览" },
  { id: "positions", label: "持仓" },
  { id: "market", label: "行情" },
  { id: "activity", label: "记录" },
  { id: "review", label: "复盘" },
  { id: "settings", label: "设置" },
];

export function TradingNavigation({ active, onNavigate, actions, status }: {
  active: TradingView;
  onNavigate?: (view: TradingView) => void;
  actions?: ReactNode;
  status?: ReactNode;
}) {
  return <header className="risk-appbar trading-appbar">
    <a href="/lab/trading" className="risk-brand">
      <span className="risk-brand__mark">Z</span>
      <span><strong>交易工作台</strong><small>Ledger / Market / Review</small></span>
    </a>
    <nav aria-label="交易工作台导航">
      {navigationItems.map((item) => onNavigate ? <button key={item.id} type="button" className={active === item.id ? "is-active" : ""} aria-current={active === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)}>{item.label}</button> : <a key={item.id} className={active === item.id ? "is-active" : ""} aria-current={active === item.id ? "page" : undefined} href={`/lab/trading?view=${item.id}`}>{item.label}</a>)}
    </nav>
    <div className="risk-appbar__actions">
      {actions}
      {status ?? <span className="trading-nav-hint">只读交易工作区</span>}
    </div>
  </header>;
}
