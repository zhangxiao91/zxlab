import type { TradingView } from "./route";
import type {
  TradingScreenAction,
  TradingScreenStatus,
  TradingScreenToggle,
} from "./screen";

const navigationItems: Array<{ id: TradingView; label: string }> = [
  { id: "overview", label: "总览" },
  { id: "positions", label: "持仓" },
  { id: "market", label: "行情" },
  { id: "activity", label: "记录" },
  { id: "review", label: "复盘" },
  { id: "settings", label: "设置" },
];

export function TradingNavigation({
  active,
  onNavigate,
  primaryAction,
  secondaryToggle,
  status,
}: {
  active: TradingView;
  onNavigate: (view: TradingView) => void;
  primaryAction?: TradingScreenAction;
  secondaryToggle?: TradingScreenToggle;
  status?: TradingScreenStatus;
}) {
  return <header className="risk-appbar trading-appbar">
    <a href="/lab/trading" className="risk-brand">
      <span className="risk-brand__mark">Z</span>
      <span><strong>交易工作台</strong><small>Ledger / Market / Review</small></span>
    </a>
    <nav aria-label="交易工作台导航">
      {navigationItems.map((item) => <button key={item.id} type="button" className={active === item.id ? "is-active" : ""} aria-current={active === item.id ? "page" : undefined} onClick={() => onNavigate(item.id)}>{item.label}</button>)}
    </nav>
    <div className="risk-appbar__actions">
      {secondaryToggle && (
        <button
          type="button"
          className="trading-shell-toggle"
          aria-pressed={secondaryToggle.pressed}
          disabled={secondaryToggle.disabled}
          onClick={() => void secondaryToggle.invoke()}
        >
          {secondaryToggle.label}
        </button>
      )}
      {primaryAction && (
        <button
          type="button"
          className="trading-shell-action"
          disabled={primaryAction.disabled || primaryAction.pending}
          onClick={() => void primaryAction.invoke()}
        >
          {primaryAction.pending
            ? (primaryAction.pendingLabel ?? primaryAction.label)
            : primaryAction.label}
        </button>
      )}
      {status ? (
        <div className="risk-appbar__status" role="status" aria-live="polite">
          <span className={`is-${status.tone}`} />
          <div>
            <strong>{status.label}</strong>
            {status.detail && <small>{status.detail}</small>}
          </div>
        </div>
      ) : (
        <span className="trading-nav-hint">只读交易工作区</span>
      )}
    </div>
  </header>;
}
