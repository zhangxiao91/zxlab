import { useEffect, useState } from "react";
import AgentToday from "../market-agent/AgentToday";
import MarketCenter from "../market/MarketCenter";
import RiskWorkbench, { type RiskView } from "../risk/RiskWorkbench";
import { TradingNavigation, type TradingView } from "./TradingNavigation";

type ReviewMode = "risk" | "market";

const viewFromLocation = (): TradingView => {
  if (typeof window === "undefined") return "overview";
  const view = new URL(window.location.href).searchParams.get("view");
  return ["overview", "positions", "market", "activity", "review", "settings"].includes(view ?? "") ? view as TradingView : "overview";
};

const reviewModeFromLocation = (): ReviewMode => {
  if (typeof window === "undefined") return "risk";
  return new URL(window.location.href).searchParams.get("mode") === "market" ? "market" : "risk";
};

const riskViewFor = (view: TradingView): RiskView => view === "positions" ? "positions" : view === "activity" ? "activity" : view === "review" ? "review" : view === "settings" ? "settings" : "dashboard";

export default function TradingWorkbench({ initialView = viewFromLocation(), initialReviewMode = reviewModeFromLocation() }: { initialView?: TradingView; initialReviewMode?: ReviewMode } = {}) {
  const [view, setView] = useState<TradingView>(() => typeof window === "undefined" ? initialView : viewFromLocation());
  const [reviewMode, setReviewMode] = useState<ReviewMode>(() => typeof window === "undefined" ? initialReviewMode : reviewModeFromLocation());

  useEffect(() => {
    const handlePopState = () => {
      setView(viewFromLocation());
      setReviewMode(reviewModeFromLocation());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (next: TradingView, mode: ReviewMode = next === "review" ? "risk" : reviewMode) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    if (next === "review" && mode === "market") url.searchParams.set("mode", "market");
    else url.searchParams.delete("mode");
    window.history.pushState({}, "", url);
    setView(next);
    setReviewMode(mode);
  };

  const changeRiskView = (next: RiskView) => navigate(next === "dashboard" ? "overview" : next);
  const reviewSwitcher = view === "review" ? <section className="trading-review-switcher" aria-label="复盘类型">
    <div><p>复盘工作流</p><h2>选择今天要解释的事实。</h2><span>账户风险和盘后市场复盘共享入口，数据边界仍然分开。</span></div>
    <div className="trading-review-switcher__tabs" role="tablist" aria-label="复盘类型">
      <button type="button" role="tab" aria-selected={reviewMode === "risk"} className={reviewMode === "risk" ? "is-active" : ""} onClick={() => navigate("review", "risk")}>账户风险复盘</button>
      <button type="button" role="tab" aria-selected={reviewMode === "market"} className={reviewMode === "market" ? "is-active" : ""} onClick={() => navigate("review", "market")}>盘后市场复盘</button>
    </div>
  </section> : null;

  return <div className="risk-app trading-shell">
    <TradingNavigation active={view} onNavigate={(next) => navigate(next)} />
    {reviewSwitcher}
    <div className="trading-shell__content">
      {view === "market" ? <MarketCenter /> : view === "review" && reviewMode === "market" ? <AgentToday /> : <RiskWorkbench embedded initialView={riskViewFor(view)} onViewChange={changeRiskView} />}
    </div>
  </div>;
}
