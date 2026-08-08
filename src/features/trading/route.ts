export type TradingView =
  | "overview"
  | "positions"
  | "market"
  | "activity"
  | "review"
  | "settings";

export type TradingReviewMode = "risk" | "market";
export type TradingAction = "import" | "holdings";

export interface TradingLocationState {
  view: TradingView;
  mode: TradingReviewMode;
  action?: TradingAction;
}

export interface TradingTarget {
  view: TradingView;
  mode?: TradingReviewMode;
  action?: TradingAction;
}

const tradingViews = new Set<TradingView>([
  "overview",
  "positions",
  "market",
  "activity",
  "review",
  "settings",
]);

const actionForView = (
  view: TradingView,
  action: string | null | undefined,
): TradingAction | undefined => {
  if (view === "activity" && action === "import") return "import";
  if (view === "positions" && action === "holdings") return "holdings";
  return undefined;
};

export function parseTradingLocation(url: URL): TradingLocationState {
  const requestedView = url.searchParams.get("view");
  const view = tradingViews.has(requestedView as TradingView)
    ? requestedView as TradingView
    : "overview";
  const mode = view === "review" && url.searchParams.get("mode") === "market"
    ? "market"
    : "risk";
  const action = actionForView(view, url.searchParams.get("action"));

  return action ? { view, mode, action } : { view, mode };
}

export function updateTradingLocation(url: URL, target: TradingTarget): URL {
  const next = new URL(url.href);
  next.searchParams.set("view", target.view);

  if (target.view === "review" && target.mode === "market") {
    next.searchParams.set("mode", "market");
  } else {
    next.searchParams.delete("mode");
  }

  const action = actionForView(target.view, target.action);
  if (action) next.searchParams.set("action", action);
  else next.searchParams.delete("action");

  return next;
}

export function clearTradingAction(url: URL): URL {
  const next = new URL(url.href);
  next.searchParams.delete("action");
  return next;
}
