import { TradingNavigation } from "./TradingNavigation";
import { TradingDialog } from "./TradingDialog";
import type { TradingScreenProjection } from "./screen";
import type {
  TradingIntent,
  TradingLocationState,
  TradingReviewMode,
  TradingView,
} from "./route";

interface TradingAppShellProps {
  location: TradingLocationState;
  projection: TradingScreenProjection;
  send(intent: TradingIntent): void;
}

const reviewTitle: Record<TradingReviewMode, string> = {
  risk: "账户风险",
  market: "盘后市场",
};

export function TradingAppShell({
  location,
  projection,
  send,
}: TradingAppShellProps) {
  const navigate = (view: TradingView) => {
    send({
      type: "navigate",
      view,
      reviewMode: view === "review" ? "risk" : undefined,
    });
  };
  const setReviewMode = (reviewMode: TradingReviewMode) => {
    send({ type: "navigate", view: "review", reviewMode });
  };
  const closeDetail = () => send({ type: "close-detail" });

  return (
    <div className="risk-app trading-shell">
      <TradingNavigation
        active={location.view}
        onNavigate={navigate}
        status={projection.status}
        primaryAction={projection.primaryAction}
        secondaryToggle={projection.secondaryToggle}
      />
      {location.view === "review" && (
        <section className="trading-review-switcher" aria-label="复盘类型">
          <div>
            <strong>{reviewTitle[location.mode]}复盘</strong>
            <span>账户事实与市场事实分别计算，共用同一个复盘入口。</span>
          </div>
          <div
            className="trading-review-switcher__tabs"
            role="tablist"
            aria-label="复盘类型"
          >
            <button
              type="button"
              role="tab"
              aria-selected={location.mode === "risk"}
              className={location.mode === "risk" ? "is-active" : ""}
              onClick={() => setReviewMode("risk")}
            >
              账户风险
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={location.mode === "market"}
              className={location.mode === "market" ? "is-active" : ""}
              onClick={() => setReviewMode("market")}
            >
              盘后市场
            </button>
          </div>
        </section>
      )}
      <div className="trading-shell__content">{projection.content}</div>
      {location.detail && projection.dialog && (
        <TradingDialog
          title={projection.dialog.title}
          description={projection.dialog.description}
          size={projection.dialog.size}
          onClose={closeDetail}
        >
          {projection.dialog.content}
        </TradingDialog>
      )}
    </div>
  );
}
