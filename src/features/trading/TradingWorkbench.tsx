import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import AgentToday, { type AgentScreenChrome } from "../market-agent/AgentToday";
import MarketCenter, { type MarketScreenChrome } from "../market/MarketCenter";
import RiskWorkbench, { type RiskView } from "../risk/RiskWorkbench";
import { TradingAppShell } from "./TradingAppShell";
import {
  createBrowserTradingHistoryAdapter,
  createTradingRoute,
  type TradingAction,
  type TradingLocationState,
  type TradingView,
} from "./route";
import type { TradingScreenProjection } from "./screen";

const riskViewFor = (view: TradingView): RiskView => view === "positions"
  ? "positions"
  : view === "activity"
    ? "activity"
    : view === "review"
      ? "review"
      : view === "settings"
        ? "settings"
        : "dashboard";

const actionFor = (location: TradingLocationState): TradingAction | undefined => {
  if (location.detail?.kind === "transaction-import") return "import";
  if (location.detail?.kind === "holdings-import") return "holdings";
  return location.action;
};

const defaultLocation: TradingLocationState = { view: "overview", mode: "risk" };

export default function TradingWorkbench({
  initialLocation = defaultLocation,
}: {
  initialLocation?: TradingLocationState;
} = {}) {
  const [route] = useState(() => createTradingRoute(createBrowserTradingHistoryAdapter()));
  const location = useSyncExternalStore(
    route.subscribe,
    route.getSnapshot,
    () => initialLocation,
  );
  const [marketChrome, setMarketChrome] = useState<MarketScreenChrome>();
  const [agentChrome, setAgentChrome] = useState<AgentScreenChrome>();

  const selectAgentRun = useCallback((runId: string) => {
    route.send({ type: "open-detail", detail: { kind: "agent-run", runId } });
  }, [route]);
  const selectAgentEvidence = useCallback((runId: string, evidenceId: string) => {
    route.send({ type: "open-detail", detail: { kind: "agent-evidence", runId, evidenceId } });
  }, [route]);

  useEffect(() => () => route.destroy(), [route]);

  const navigateRiskView = (next: RiskView) => {
    route.send({
      type: "navigate",
      view: next === "dashboard" ? "overview" : next,
      reviewMode: next === "review" ? "risk" : undefined,
    });
  };
  const changeRiskAction = (action: TradingAction | undefined) => {
    if (!action) {
      route.send({ type: "close-detail" });
      return;
    }
    route.send({
      type: "open-detail",
      detail: action === "import"
        ? { kind: "transaction-import" }
        : { kind: "holdings-import" },
    });
  };

  let projection: TradingScreenProjection;
  if (location.view === "market") {
    projection = {
      content: <MarketCenter embedded onScreenChange={setMarketChrome} />,
      ...marketChrome,
    };
  } else if (location.view === "review" && location.mode === "market") {
    const selectedRunId = location.detail?.kind === "agent-run" || location.detail?.kind === "agent-evidence"
      ? location.detail.runId
      : null;
    const selectedEvidenceId = location.detail?.kind === "agent-evidence" ? location.detail.evidenceId : null;
    projection = {
      content: <AgentToday
        embedded
        selectedRunId={selectedRunId}
        selectedEvidenceId={selectedEvidenceId}
        onSelectedRunChange={selectAgentRun}
        onSelectedEvidenceChange={selectAgentEvidence}
        onScreenChange={setAgentChrome}
      />,
      ...agentChrome,
    };
  } else {
    projection = {
      content: (
        <RiskWorkbench
          embedded
          initialView={riskViewFor(location.view)}
          action={actionFor(location)}
          onViewChange={navigateRiskView}
          onActionChange={changeRiskAction}
        />
      ),
    };
  }

  return (
    <TradingAppShell
      location={location}
      projection={projection}
      send={route.send}
    />
  );
}
