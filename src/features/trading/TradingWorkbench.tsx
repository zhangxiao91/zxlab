import { useEffect, useState } from "react";
import AgentToday from "../market-agent/AgentToday";
import MarketCenter from "../market/MarketCenter";
import RiskWorkbench, { type RiskView } from "../risk/RiskWorkbench";
import TradingGuidance from "./TradingGuidance";
import { TradingNavigation } from "./TradingNavigation";
import {
  clearTradingAction,
  parseTradingLocation,
  updateTradingLocation,
  type TradingAction,
  type TradingLocationState,
  type TradingTarget,
  type TradingView,
} from "./route";

const riskViewFor = (view: TradingView): RiskView => view === "positions" ? "positions" : view === "activity" ? "activity" : view === "review" ? "review" : view === "settings" ? "settings" : "dashboard";

const defaultLocation: TradingLocationState = { view: "overview", mode: "risk" };

export default function TradingWorkbench({ initialLocation = defaultLocation }: { initialLocation?: TradingLocationState } = {}) {
  const [location, setLocation] = useState<TradingLocationState>(initialLocation);

  useEffect(() => {
    const handlePopState = () => {
      setLocation(parseTradingLocation(new URL(window.location.href)));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (target: TradingTarget) => {
    const url = updateTradingLocation(new URL(window.location.href), target);
    window.history.pushState({}, "", url);
    setLocation(parseTradingLocation(url));
  };

  const navigateView = (view: TradingView) => navigate({
    view,
    mode: view === "review" ? "risk" : undefined,
  });
  const changeRiskView = (next: RiskView) => navigateView(next === "dashboard" ? "overview" : next);
  const handleActionChange = (action: TradingAction | undefined) => {
    if (action) {
      navigate({
        view: action === "import" ? "activity" : "positions",
        action,
      });
      return;
    }

    const url = clearTradingAction(new URL(window.location.href));
    window.history.replaceState({}, "", url);
    setLocation(parseTradingLocation(url));
  };
  const { view, mode: reviewMode, action } = location;
  const inReview = view === "review";
  const marketReview = inReview && reviewMode === "market";
  const reviewSwitcher = inReview ? <section className="trading-review-switcher" aria-label="复盘类型">
    <div><p>复盘工作流</p><h2>选择今天要解释的事实。</h2><span>账户风险和盘后市场复盘共享入口，数据边界仍然分开。</span></div>
    <div className="trading-review-switcher__tabs" role="tablist" aria-label="复盘类型">
      <button type="button" role="tab" aria-selected={reviewMode === "risk"} className={reviewMode === "risk" ? "is-active" : ""} onClick={() => navigate({ view: "review", mode: "risk" })}>账户风险复盘</button>
      <button type="button" role="tab" aria-selected={reviewMode === "market"} className={reviewMode === "market" ? "is-active" : ""} onClick={() => navigate({ view: "review", mode: "market" })}>盘后市场复盘</button>
    </div>
  </section> : null;

  return <div className="risk-app trading-shell">
    <TradingNavigation active={view} onNavigate={navigateView} />
    {!marketReview && <TradingGuidance active={view} reviewMode={reviewMode} onNavigate={navigate} />}
    {reviewSwitcher}
    <div className="trading-shell__content">
      {view === "market" ? <MarketCenter embedded /> : marketReview ? <AgentToday embedded /> : <RiskWorkbench embedded initialView={riskViewFor(view)} action={action} onViewChange={changeRiskView} onActionChange={handleActionChange} />}
    </div>
  </div>;
}
