export type TradingView =
  | "overview"
  | "positions"
  | "market"
  | "activity"
  | "review"
  | "settings";

export type TradingReviewMode = "risk" | "market";

export type TradingDetail =
  | { kind: "transaction-import" }
  | { kind: "holdings-import" }
  | { kind: "risk-evidence"; evidenceId: string }
  | { kind: "agent-run"; runId: string }
  | { kind: "agent-evidence"; runId: string; evidenceId: string };

/** @deprecated Use TradingDetail and the open-detail intent. */
export type TradingAction = "import" | "holdings";

export interface TradingLocationState {
  view: TradingView;
  mode: TradingReviewMode;
  detail?: TradingDetail;
  /** @deprecated Read detail instead. Retained temporarily for source compatibility. */
  action?: TradingAction;
}

export interface TradingTarget {
  view: TradingView;
  mode?: TradingReviewMode;
  detail?: TradingDetail;
  /** @deprecated Use detail instead. */
  action?: TradingAction;
}

export type TradingIntent =
  | {
      type: "navigate";
      view: TradingView;
      reviewMode?: TradingReviewMode;
    }
  | { type: "open-detail"; detail: TradingDetail }
  | { type: "close-detail" };

export type TradingRouteListener = () => void;

/**
 * The only history surface the trading route needs. Keeping this adapter small
 * makes route transitions deterministic in tests and keeps DOM history out of
 * screens and shells.
 */
export interface TradingHistoryAdapter {
  getHref(): string;
  push(href: string): void;
  replace(href: string): void;
  subscribe(listener: TradingRouteListener): () => void;
}

export interface TradingRoute {
  getSnapshot(): TradingLocationState;
  subscribe(listener: TradingRouteListener): () => void;
  send(intent: TradingIntent): void;
  destroy(): void;
}

const tradingViews = new Set<TradingView>([
  "overview",
  "positions",
  "market",
  "activity",
  "review",
  "settings",
]);

const ownedSearchParams = ["mode", "action", "evidence", "run"] as const;

const nonEmptyParam = (value: string | null): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const isRiskWorkspace = (
  view: TradingView,
  mode: TradingReviewMode,
): boolean => view !== "market" && !(view === "review" && mode === "market");

export function isTradingDetailCompatible(
  view: TradingView,
  mode: TradingReviewMode,
  detail: TradingDetail,
): boolean {
  switch (detail.kind) {
    case "transaction-import":
      return view === "activity";
    case "holdings-import":
      return view === "positions";
    case "risk-evidence":
      return isRiskWorkspace(view, mode);
    case "agent-run":
    case "agent-evidence":
      return view === "review" && mode === "market";
  }
}

const detailFromSearchParams = (
  view: TradingView,
  mode: TradingReviewMode,
  params: URLSearchParams,
): TradingDetail | undefined => {
  const action = params.get("action");
  if (view === "activity" && action === "import") {
    return { kind: "transaction-import" };
  }
  if (view === "positions" && action === "holdings") {
    return { kind: "holdings-import" };
  }
  const runId = nonEmptyParam(params.get("run"));
  if (action !== "evidence") {
    const detail: TradingDetail | undefined = runId ? { kind: "agent-run", runId } : undefined;
    return detail && isTradingDetailCompatible(view, mode, detail) ? detail : undefined;
  }

  const evidenceId = nonEmptyParam(params.get("evidence"));
  if (!evidenceId) return undefined;

  const detail: TradingDetail = runId
    ? { kind: "agent-evidence", runId, evidenceId }
    : { kind: "risk-evidence", evidenceId };
  return isTradingDetailCompatible(view, mode, detail) ? detail : undefined;
};

const legacyDetail = (
  view: TradingView,
  action: TradingAction | undefined,
): TradingDetail | undefined => {
  if (view === "activity" && action === "import") {
    return { kind: "transaction-import" };
  }
  if (view === "positions" && action === "holdings") {
    return { kind: "holdings-import" };
  }
  return undefined;
};

const writeTradingDetail = (
  url: URL,
  view: TradingView,
  mode: TradingReviewMode,
  detail: TradingDetail | undefined,
): void => {
  for (const param of ownedSearchParams) url.searchParams.delete(param);
  if (!detail || !isTradingDetailCompatible(view, mode, detail)) return;

  switch (detail.kind) {
    case "transaction-import":
      url.searchParams.set("action", "import");
      return;
    case "holdings-import":
      url.searchParams.set("action", "holdings");
      return;
    case "risk-evidence":
      url.searchParams.set("action", "evidence");
      url.searchParams.set("evidence", detail.evidenceId);
      return;
    case "agent-run":
      url.searchParams.set("run", detail.runId);
      return;
    case "agent-evidence":
      url.searchParams.set("action", "evidence");
      url.searchParams.set("evidence", detail.evidenceId);
      url.searchParams.set("run", detail.runId);
  }
};

export function parseTradingLocation(url: URL): TradingLocationState {
  const requestedView = url.searchParams.get("view");
  const view = tradingViews.has(requestedView as TradingView)
    ? requestedView as TradingView
    : "overview";
  const mode = view === "review" && url.searchParams.get("mode") === "market"
    ? "market"
    : "risk";
  const detail = detailFromSearchParams(view, mode, url.searchParams);

  return detail ? { view, mode, detail } : { view, mode };
}

export function updateTradingLocation(url: URL, target: TradingTarget): URL {
  const next = new URL(url.href);
  const mode = target.view === "review" && target.mode === "market"
    ? "market"
    : "risk";
  const detail = target.detail ?? legacyDetail(target.view, target.action);

  next.searchParams.set("view", target.view);
  writeTradingDetail(next, target.view, mode, detail);
  if (target.view === "review" && mode === "market") {
    next.searchParams.set("mode", "market");
  }

  return next;
}

export function clearTradingDetail(url: URL): URL {
  const next = new URL(url.href);
  for (const param of ["action", "evidence", "run"] as const) {
    next.searchParams.delete(param);
  }
  return next;
}

/** @deprecated Use clearTradingDetail. */
export const clearTradingAction = clearTradingDetail;

const detailForOpenIntent = (
  current: TradingLocationState,
  detail: TradingDetail,
): Pick<TradingLocationState, "view" | "mode"> => {
  if (isTradingDetailCompatible(current.view, current.mode, detail)) {
    return current;
  }

  switch (detail.kind) {
    case "transaction-import":
      return { view: "activity", mode: "risk" };
    case "holdings-import":
      return { view: "positions", mode: "risk" };
    case "risk-evidence":
      return { view: "overview", mode: "risk" };
    case "agent-run":
    case "agent-evidence":
      return { view: "review", mode: "market" };
  }
};

const sameDetail = (
  left: TradingDetail | undefined,
  right: TradingDetail | undefined,
): boolean => {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "risk-evidence" && right.kind === "risk-evidence") {
    return left.evidenceId === right.evidenceId;
  }
  if (left.kind === "agent-evidence" && right.kind === "agent-evidence") {
    return left.runId === right.runId && left.evidenceId === right.evidenceId;
  }
  if (left.kind === "agent-run" && right.kind === "agent-run") return left.runId === right.runId;
  return true;
};

const sameLocation = (
  left: TradingLocationState,
  right: TradingLocationState,
): boolean => left.view === right.view
  && left.mode === right.mode
  && sameDetail(left.detail, right.detail);

export function createTradingRoute(
  history: TradingHistoryAdapter,
): TradingRoute {
  let snapshot = parseTradingLocation(new URL(history.getHref()));
  let destroyed = false;
  const listeners = new Set<TradingRouteListener>();

  const publish = (next: TradingLocationState) => {
    if (sameLocation(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const syncFromHistory = () => {
    if (destroyed) return;
    publish(parseTradingLocation(new URL(history.getHref())));
  };
  const unsubscribeHistory = history.subscribe(syncFromHistory);

  const commit = (method: "push" | "replace", url: URL) => {
    const next = parseTradingLocation(url);
    if (sameLocation(snapshot, next)) return;
    history[method](url.href);
    publish(next);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(intent) {
      if (destroyed) return;

      const currentUrl = new URL(history.getHref());
      const current = parseTradingLocation(currentUrl);
      if (intent.type === "close-detail") {
        commit("replace", clearTradingDetail(currentUrl));
        return;
      }

      if (intent.type === "open-detail") {
        const target = detailForOpenIntent(current, intent.detail);
        commit("push", updateTradingLocation(currentUrl, {
          ...target,
          detail: intent.detail,
        }));
        return;
      }

      const mode = intent.view === "review"
        ? intent.reviewMode ?? "risk"
        : "risk";
      const detail = current.detail
        && isTradingDetailCompatible(intent.view, mode, current.detail)
        ? current.detail
        : undefined;
      commit("push", updateTradingLocation(currentUrl, {
        view: intent.view,
        mode,
        detail,
      }));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribeHistory();
      listeners.clear();
    },
  };
}

type BrowserHistoryWindow = Pick<Window, "location" | "history" | "addEventListener" | "removeEventListener">;

export function createBrowserTradingHistoryAdapter(
  browserWindow: BrowserHistoryWindow = window,
): TradingHistoryAdapter {
  return {
    getHref: () => browserWindow.location.href,
    push: (href) => browserWindow.history.pushState({}, "", href),
    replace: (href) => browserWindow.history.replaceState({}, "", href),
    subscribe(listener) {
      browserWindow.addEventListener("popstate", listener);
      return () => browserWindow.removeEventListener("popstate", listener);
    },
  };
}

export const createBrowserTradingHistory = createBrowserTradingHistoryAdapter;
