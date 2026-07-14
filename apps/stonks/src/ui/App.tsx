import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Activity, BarChart3, ChevronsRight, Pause, Play, RefreshCw, Star, Wallet } from "lucide-react";
import { GAME_CONFIG, roundMoney } from "../game/config";
import { createInitialGame } from "../game/createInitialGame";
import { getValuationSnapshot } from "../game/fundamentals";
import type { BoardState, DailyCandle, ExecutionFill, GameState, NewsItem, PlayerAction, Stock, StockId, TickPrice, TickResult } from "../game/types";
import { getLowerLimit, getUpperLimit } from "../simulation/boardEngine";
import { canCancelAuctionOrder, canSubmitAuctionOrder, CONTINUOUS_START_TICK } from "../simulation/auctionEngine";
import { createMarketDepth } from "../simulation/marketDepth";
import { calculateEffectiveDepth, getMarketCapClass } from "../simulation/marketDepth";
import { updateTick } from "../simulation/tick";
import { getReservedCash } from "../player/portfolio";

type TradeSide = "buy" | "sell";
type NavPage = "market" | "fundamentals" | "portfolio";
type KLineRange = 5 | 20 | 60 | "all";
type KLineAxisMode = "auto" | "pct10" | "pct20";
type MarketTone = "up" | "down" | "flat";
type StockTraceView = TickResult["stocks"][number];
type TradeMark = {
  side: "buy" | "sell";
  day: number;
  tick: number;
  price: number;
  shares: number;
  notional: number;
  count: number;
};
type ChartHover = {
  x: number;
  y: number;
  tick: number;
  coordPrice: number;
  point: TickPrice;
};
type PlayerFillRecord = {
  day: number;
  tick: number;
  fill: ExecutionFill;
};
type DailyTradeMark = {
  side: "buy" | "sell";
  day: number;
  price: number;
  shares: number;
  notional: number;
  count: number;
};
type KLineHover = {
  x: number;
  y: number;
  coordPrice: number;
  candle: DailyCandle;
  index: number;
};
type OrderToast = {
  id: string;
  kind: "success" | "failure";
  side: TradeSide;
  stockId: StockId;
  shares: number;
  price: number;
  day: number;
  tick: number;
  message: string;
};
type ConditionSpec =
  | {
      type: "day";
      targetDay: number;
    }
  | {
      type: "tick";
      targetTick: number;
    }
  | {
      type: "price";
      operator: "above" | "below";
      triggerPrice: number;
    };
type ConditionalOrder = {
  id: string;
  side: TradeSide;
  stockId: StockId;
  shares: number;
  limitPrice: number;
  condition: ConditionSpec;
  createdDay: number;
  createdTick: number;
  working?: boolean;
};
type OrderIntent = {
  id: string;
  source: "normal" | "conditional" | "cancel";
  side: TradeSide;
  stockId: StockId;
  shares: number;
  limitPrice: number;
  submittedDay: number;
  submittedTick: number;
};
type FastForwardState = {
  active: boolean;
  startDay: number;
  restoreRunning: boolean;
};
type WhaleIndexSnapshot = {
  value: number;
  change: number;
  changePct: number;
  tone: MarketTone;
};
type WhaleFeedRow = {
  key: string;
  day: number;
  tick: number;
  whale: string;
  side: "buy" | "sell";
  stockId: StockId;
  shares: number;
  avgPrice: number;
  intention: string;
};
type SaveStatus = {
  label: string;
  tone: "saved" | "loaded" | "error" | "empty";
};
type AutosaveFile = {
  version: 1;
  savedAt: string;
  game: GameState;
  ui: {
    selectedStockId: StockId;
    tickIntervalSeconds: number;
    kLineRange: KLineRange;
    kLineAxisMode: KLineAxisMode;
    navPage: NavPage;
    showTradeMarks: boolean;
    simpleMarketMode: boolean;
    indexBaseValue: number;
    playerFillHistory: PlayerFillRecord[];
    conditionalOrders?: ConditionalOrder[];
  };
};

const AUTOSAVE_KEY = "zxlab:stonks:auto-save:v1";
const SHORTCUTS_SEEN_KEY = "zxlab:stonks:shortcuts-seen:v1";

const stockIds: StockId[] = [
  "DRAGON_SOFT",
  "NEW_HORIZON_BIO",
  "GOLDEN_ROOF",
  "PEARL_DAILY",
  "RED_RIVER_LITHIUM",
  "HARBOR_BANK",
  "SKY_SHIELD",
  "EAST_GRID_ENERGY",
  "CLOUDHARBOR_AI",
  "MIRROR_LAKE_MED",
  "SILVER_PINES_SOLAR",
  "NORTHSTAR_ROBOTICS",
  "RIVERSTONE_CEMENT",
  "ORCHID_SNACKS",
  "WESTERN_CLOUD_BANK",
  "COPPER_CROWN_MINING",
  "ETF_BROAD_MARKET",
  "ETF_TECH_GROWTH",
  "ETF_BIOTECH_INNOVATION",
  "ETF_PROPERTY_VALUE",
  "ETF_DEFENSE_SECURITY"
];

export function App() {
  const [initialSave] = useState(() => readAutosave());
  const gameRef = useRef<GameState>(initialSave?.game ?? createInitialUiGame("web-mvp"));
  const indexBaseValueRef = useRef(initialSave?.ui.indexBaseValue ?? calculateWeightedMarketValue(gameRef.current));
  const [, setGameVersion] = useState(0);
  const game = gameRef.current;
  const [selectedStockId, setSelectedStockId] = useState<StockId>(() => getInitialStockId(initialSave, gameRef.current));
  const [recentResults, setRecentResults] = useState<TickResult[]>([]);
  const [playerFillHistory, setPlayerFillHistory] = useState<PlayerFillRecord[]>(() => initialSave?.ui.playerFillHistory ?? []);
  const [conditionalOrders, setConditionalOrders] = useState<ConditionalOrder[]>(() => initialSave?.ui.conditionalOrders ?? []);
  const [orderToasts, setOrderToasts] = useState<OrderToast[]>([]);
  const [pendingActions, setPendingActions] = useState<PlayerAction[]>([]);
  const [running, setRunning] = useState(() => !initialSave);
  const [tickIntervalSeconds, setTickIntervalSeconds] = useState<number>(() => initialSave?.ui.tickIntervalSeconds ?? GAME_CONFIG.tickDurationSeconds);
  const [fastForward, setFastForward] = useState<FastForwardState>({ active: false, startDay: 0, restoreRunning: true });
  const [kLineRange, setKLineRange] = useState<KLineRange>(() => initialSave?.ui.kLineRange ?? 20);
  const [kLineAxisMode, setKLineAxisMode] = useState<KLineAxisMode>(() => initialSave?.ui.kLineAxisMode ?? "auto");
  const [tradeSide, setTradeSide] = useState<TradeSide>("buy");
  const [showTradeMarks, setShowTradeMarks] = useState(() => initialSave?.ui.showTradeMarks ?? false);
  const [simpleMarketMode, setSimpleMarketMode] = useState(() => initialSave?.ui.simpleMarketMode ?? false);
  const [quantity, setQuantity] = useState("10000");
  const [limitPrice, setLimitPrice] = useState(() => gameRef.current.stocks.DRAGON_SOFT.price.toFixed(2));
  const [navPage, setNavPage] = useState<NavPage>(() => initialSave?.ui.navPage ?? "market");
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(() => {
    try {
      return window.localStorage.getItem(SHORTCUTS_SEEN_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const [ticketMessage, setTicketMessage] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(() =>
    initialSave
      ? {
          label: `Loaded autosave ${formatSaveTime(initialSave.savedAt)}`,
          tone: "loaded"
        }
      : {
          label: "No autosave yet",
          tone: "empty"
        }
  );
  const pendingActionsRef = useRef<PlayerAction[]>([]);
  const pendingOrderIntentsRef = useRef<OrderIntent[]>([]);
  const conditionalOrdersRef = useRef<ConditionalOrder[]>(conditionalOrders);
  const fastForwardRef = useRef<FastForwardState>(fastForward);
  const playerFillHistoryRef = useRef<PlayerFillRecord[]>(playerFillHistory);

  const selectedStock = game.stocks[selectedStockId];
  const whaleIndex = calculateWhaleIndex(game, indexBaseValueRef.current);
  const selectedTrace = useMemo(() => {
    return recentResults.map((result) => result.stocks.find((stock) => stock.stockId === selectedStockId)).find(Boolean);
  }, [recentResults, selectedStockId]);

  const addOrderToast = useCallback((toast: Omit<OrderToast, "id">) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setOrderToasts((current) => [{ ...toast, id }, ...current].slice(0, 5));
    window.setTimeout(() => {
      setOrderToasts((current) => current.filter((item) => item.id !== id));
    }, 2400);
  }, []);

  const queueAction = useCallback((action: PlayerAction, intent: OrderIntent) => {
    setPendingActions((current) => {
      const next = [...current, action];
      pendingActionsRef.current = next;
      return next;
    });
    pendingOrderIntentsRef.current = [...pendingOrderIntentsRef.current, intent];
  }, []);

  useEffect(() => {
    fastForwardRef.current = fastForward;
  }, [fastForward]);

  useEffect(() => {
    playerFillHistoryRef.current = playerFillHistory;
  }, [playerFillHistory]);

  useEffect(() => {
    conditionalOrdersRef.current = conditionalOrders;
  }, [conditionalOrders]);

  const writeCurrentAutosave = useCallback((showStatus = false) => {
    const success = writeAutosave({
      game: gameRef.current,
      selectedStockId,
      tickIntervalSeconds,
      kLineRange,
      kLineAxisMode,
      navPage,
      showTradeMarks,
      simpleMarketMode,
      indexBaseValue: indexBaseValueRef.current,
      playerFillHistory: playerFillHistoryRef.current,
      conditionalOrders: conditionalOrdersRef.current
    });
    if (showStatus) {
      setSaveStatus(
        success
          ? { label: `Autosaved D${gameRef.current.day} T${gameRef.current.tick}`, tone: "saved" }
          : { label: "Autosave failed", tone: "error" }
      );
    }
  }, [kLineAxisMode, kLineRange, navPage, selectedStockId, showTradeMarks, simpleMarketMode, tickIntervalSeconds]);

  useEffect(() => {
    const handleBeforeUnload = () => writeCurrentAutosave(false);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [writeCurrentAutosave]);

  const step = useCallback(() => {
    const nextGame = gameRef.current;
    const actions = pendingActionsRef.current;
    const orderIntents = pendingOrderIntentsRef.current;
    const triggered = getTriggeredConditionalOrders(nextGame, conditionalOrdersRef.current);
    const triggeredActions = triggered.map((order) => conditionalOrderToAction(order));
    const triggeredIntents = triggered.map((order) => conditionalOrderToIntent(order, nextGame.day, nextGame.tick));
    const submittedActions = [...actions, ...triggeredActions];
    const submittedIntents = [...orderIntents, ...triggeredIntents];
    pendingActionsRef.current = [];
    pendingOrderIntentsRef.current = [];
    setPendingActions([]);
    if (triggered.length > 0) {
      setTicketMessage(`${triggered.length} conditional order${triggered.length === 1 ? "" : "s"} triggered.`);
    }
    const result = updateTick(nextGame, submittedActions);
    const shouldAutosave = result.phaseChanged === "preMarket" || nextGame.phase === "ended";
    if (triggered.length > 0 || result.playerFills.length > 0) {
      setConditionalOrders((current) => {
        const next = reconcileConditionalOrdersAfterTick(current, triggered, result);
        conditionalOrdersRef.current = next;
        return next;
      });
    }

    setGameVersion((version) => version + 1);
    setRecentResults((current) => [result, ...current].slice(0, 120));
    createOrderToasts(result, submittedIntents, nextGame).forEach(addOrderToast);
    if (result.playerFills.length > 0) {
      const fillRecords = result.playerFills.map((fill) => ({ day: result.day, tick: result.tick, fill }));
      setPlayerFillHistory((current) => {
        const next = [...current, ...fillRecords].slice(-800);
        playerFillHistoryRef.current = next;
        return next;
      });
    }
    if (shouldAutosave) {
      const success = writeAutosave({
        game: nextGame,
        selectedStockId,
        tickIntervalSeconds,
        kLineRange,
        kLineAxisMode,
        navPage,
        showTradeMarks,
        simpleMarketMode,
        indexBaseValue: indexBaseValueRef.current,
        playerFillHistory: playerFillHistoryRef.current,
        conditionalOrders: conditionalOrdersRef.current
      });
      setSaveStatus(
        success
          ? { label: `Autosaved D${nextGame.day} T${nextGame.tick}`, tone: "saved" }
          : { label: "Autosave failed", tone: "error" }
      );
    }
    if (nextGame.phase === "ended") {
      fastForwardRef.current = { active: false, startDay: 0, restoreRunning: false };
      setFastForward(fastForwardRef.current);
      setRunning(false);
    } else if (fastForwardRef.current.active && nextGame.day > fastForwardRef.current.startDay) {
      const restoreRunning = fastForwardRef.current.restoreRunning;
      fastForwardRef.current = { active: false, startDay: 0, restoreRunning };
      setFastForward(fastForwardRef.current);
      setRunning(restoreRunning);
    }
  }, [addOrderToast, kLineAxisMode, kLineRange, navPage, selectedStockId, showTradeMarks, simpleMarketMode, tickIntervalSeconds]);

  const effectiveTickIntervalSeconds = fastForward.active ? 0.02 : tickIntervalSeconds;

  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => step(), effectiveTickIntervalSeconds * 1000);
    return () => window.clearInterval(id);
  }, [effectiveTickIntervalSeconds, running, step]);

  useEffect(() => {
    setLimitPrice(gameRef.current.stocks[selectedStockId].price.toFixed(2));
    setTicketMessage("");
  }, [selectedStockId]);

  const resetRun = () => {
    const fresh = createInitialUiGame(`web-mvp-${Date.now()}`);
    gameRef.current = fresh;
    indexBaseValueRef.current = calculateWeightedMarketValue(fresh);
    clearAutosave();
    setSaveStatus({ label: "Autosave cleared", tone: "empty" });
    setGameVersion((version) => version + 1);
    setRecentResults([]);
    setPlayerFillHistory([]);
    setConditionalOrders([]);
    setOrderToasts([]);
    pendingActionsRef.current = [];
    pendingOrderIntentsRef.current = [];
    conditionalOrdersRef.current = [];
    setPendingActions([]);
    setRunning(true);
    fastForwardRef.current = { active: false, startDay: 0, restoreRunning: true };
    setFastForward(fastForwardRef.current);
    setTickIntervalSeconds(GAME_CONFIG.tickDurationSeconds);
    setKLineRange(20);
    setKLineAxisMode("auto");
    setSelectedStockId("DRAGON_SOFT");
    setTradeSide("buy");
    setQuantity("10000");
    setLimitPrice(fresh.stocks.DRAGON_SOFT.price.toFixed(2));
    setTicketMessage("");
  };

  const toggleFastForward = () => {
    const current = fastForwardRef.current;
    if (current.active) {
      fastForwardRef.current = { active: false, startDay: 0, restoreRunning: current.restoreRunning };
      setFastForward(fastForwardRef.current);
      setRunning(current.restoreRunning);
      return;
    }

    const next = {
      active: true,
      startDay: gameRef.current.day,
      restoreRunning: running
    };
    fastForwardRef.current = next;
    setFastForward(next);
    setRunning(true);
  };

  const toggleRunning = () => {
    if (fastForwardRef.current.active) {
      fastForwardRef.current = { active: false, startDay: 0, restoreRunning: false };
      setFastForward(fastForwardRef.current);
      setRunning(false);
      return;
    }

    setRunning((value) => !value);
  };

  const clearCurrentAutosave = () => {
    clearAutosave();
    setSaveStatus({ label: "Autosave cleared", tone: "empty" });
  };

  const submitOrder = () => {
    const shares = Math.max(0, Math.floor(Number(quantity)));
    const price = Math.max(0, Number(limitPrice));

    if (!canSubmitAuctionOrder(game.tick) && game.phase !== "intraday" && game.phase !== "closingAuction") {
      setTicketMessage("Trading is closed in the current stage.");
      return;
    }
    if (shares <= 0 || price <= 0) {
      setTicketMessage("Enter a positive share quantity and limit price.");
      return;
    }

    const action: PlayerAction =
      tradeSide === "buy"
        ? {
            type: "marketBuy",
            stockId: selectedStockId,
            amountCash: roundMoney(shares * price),
            limitPrice: price
          }
        : {
            type: "marketSell",
            stockId: selectedStockId,
            shares,
            limitPrice: price
          };

    queueAction(action, {
      id: `normal-${game.day}-${game.tick}-${selectedStockId}-${Date.now()}`,
      source: "normal",
      side: tradeSide,
      stockId: selectedStockId,
      shares,
      limitPrice: price,
      submittedDay: game.day,
      submittedTick: game.tick
    });
    setTicketMessage(`${tradeSide === "buy" ? "Buy" : "Sell"} order queued for the next tick at limit ${price.toFixed(2)}.`);
  };

  const cancelAuctionOrder = (orderId: string) => {
    queueAction({ type: "cancelAuctionOrder", orderId }, {
      id: `cancel-${game.day}-${game.tick}-${orderId}`,
      source: "cancel",
      side: "buy",
      stockId: selectedStockId,
      shares: 0,
      limitPrice: 0,
      submittedDay: game.day,
      submittedTick: game.tick
    });
    setTicketMessage(`Cancel request queued for ${orderId}.`);
  };

  const submitConditionalOrder = (order: Omit<ConditionalOrder, "id" | "stockId" | "createdDay" | "createdTick">) => {
    const conditionalOrder: ConditionalOrder = {
      ...order,
      id: `cond-${game.day}-${game.tick}-${selectedStockId}-${Date.now()}`,
      stockId: selectedStockId,
      createdDay: game.day,
      createdTick: game.tick
    };
    setConditionalOrders((current) => {
      const next = [conditionalOrder, ...current].slice(0, 12);
      conditionalOrdersRef.current = next;
      return next;
    });
    setTicketMessage(`Conditional ${order.side} order armed: ${formatCondition(order.condition)}.`);
  };

  const cancelConditionalOrder = (orderId: string) => {
    setConditionalOrders((current) => {
      const next = current.filter((order) => order.id !== orderId);
      conditionalOrdersRef.current = next;
      return next;
    });
  };

  const closeShortcutHelp = () => {
    setShortcutHelpOpen(false);
    try {
      window.localStorage.setItem(SHORTCUTS_SEEN_KEY, "1");
    } catch {
      // The help remains available through ? even when storage is unavailable.
    }
  };

  const selectAdjacentStock = (direction: 1 | -1) => {
    const currentIndex = stockIds.indexOf(selectedStockId);
    const nextIndex = (currentIndex + direction + stockIds.length) % stockIds.length;
    setSelectedStockId(stockIds[nextIndex]);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditable = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));

      if (event.key === "Escape") {
        if (shortcutHelpOpen) {
          event.preventDefault();
          closeShortcutHelp();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitOrder();
        return;
      }

      if (isEditable || event.repeat) return;

      if (event.key === "?") {
        event.preventDefault();
        setShortcutHelpOpen(true);
        return;
      }

      switch (event.key.toLowerCase()) {
        case " ":
          event.preventDefault();
          toggleRunning();
          break;
        case "f":
          event.preventDefault();
          toggleFastForward();
          break;
        case "j":
          event.preventDefault();
          selectAdjacentStock(-1);
          break;
        case "k":
          event.preventDefault();
          selectAdjacentStock(1);
          break;
        case "1":
          event.preventDefault();
          setNavPage("market");
          break;
        case "2":
          event.preventDefault();
          setNavPage("fundamentals");
          break;
        case "3":
          event.preventDefault();
          setNavPage("portfolio");
          break;
        case "b":
          event.preventDefault();
          setTradeSide("buy");
          break;
        case "s":
          event.preventDefault();
          setTradeSide("sell");
          break;
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  });

  const depth = useMemo(() => {
    const pressure = selectedTrace?.pressure;
    return createMarketDepth(selectedStock, {
      buyPressure: pressure?.buyPressure ?? 0,
      sellPressure: pressure?.sellPressure ?? 0
    });
  }, [selectedStock, selectedTrace]);

  const whaleRows = useMemo(() => {
    return recentResults
      .flatMap((result) =>
        result.whaleTrades.map((trade) => ({
          key: `${result.day}-${result.tick}-${trade.ownerId}-${trade.stockId}-${trade.side}-${trade.filledNotional}`,
          day: result.day,
          tick: result.tick,
          whale: trade.ownerName ?? "Unknown Whale",
          side: trade.side,
          stockId: trade.stockId,
          shares: trade.filledShares,
          avgPrice: trade.avgPrice,
          intention: trade.intention ?? "idle"
        }))
      )
      .slice(0, 12);
  }, [recentResults]);

  const lowerPanelMode = navPage === "portfolio" ? "portfolio" : "fundamentals";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={21} strokeWidth={2.4} />
          </div>
          <div>
            <div className="brand-title">Whale-Sim</div>
            <div className="brand-subtitle">A-Share Tactics Game</div>
          </div>
        </div>

        <WhaleIndexBar index={whaleIndex} />

        <nav className="main-nav" aria-label="Main views">
          {(["market", "fundamentals", "portfolio"] as NavPage[]).map((page, index) => (
            <button className={navPage === page ? "active" : ""} key={page} onClick={() => setNavPage(page)} title={`${titleCase(page)} · ${index + 1}`}>
              {titleCase(page)} <kbd>{index + 1}</kbd>
            </button>
          ))}
        </nav>

        <div className="clock-block">
          <div className="clock-item">
            <span>Day</span>
            <strong>{game.day} / {GAME_CONFIG.totalDays}</strong>
          </div>
          <div className="progress-with-skip">
            <ProgressBar
              value={(game.day - 1) / GAME_CONFIG.totalDays}
              dayValue={game.tick / GAME_CONFIG.ticksPerDay}
              tick={game.tick}
            />
            <button
              className={fastForward.active ? "fast-forward-button active" : "fast-forward-button"}
              onClick={toggleFastForward}
              type="button"
              aria-label={fastForward.active ? "Stop fast forward" : "Fast forward to next day"}
              title={`${fastForward.active ? "Stop fast forward" : "Fast forward to next day"} · F`}
            >
              <ChevronsRight size={14} strokeWidth={2.4} />
            </button>
          </div>
          <div className="clock-item">
            <span>Tick</span>
            <strong>{game.tick} / {GAME_CONFIG.ticksPerDay}</strong>
          </div>
        </div>

        <div className="run-controls">
          <button className="icon-button primary" onClick={toggleRunning} aria-label={running ? "Pause" : "Play"} title={`${running ? "Pause" : "Play"} · Space`}>
            {running ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button className="icon-button" onClick={resetRun} aria-label="Reset run">
            <RefreshCw size={17} />
          </button>
          <AutosaveStatus status={saveStatus} onSave={() => writeCurrentAutosave(true)} onClear={clearCurrentAutosave} />
          <label className="speed-control">
            <span>Speed</span>
            <select value={tickIntervalSeconds} onChange={(event) => setTickIntervalSeconds(Number(event.target.value))}>
              {[0.25, 0.5, 1, 2, 5].map((speed) => (
                <option key={speed} value={speed}>{speed}s/tick</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <section className="fund-strip" aria-label="Fund state">
        <Metric label="Cash" value={shortMoney(game.player.cash)} />
        <Metric label="Reserved Cash" value={shortMoney(getReservedCash(game))} />
        <Metric label="Net Worth" value={shortMoney(game.player.netWorth)} />
        <Metric label="Unrealized P&L" value={signedShortMoney(game.player.unrealizedPnl)} tone={game.player.unrealizedPnl >= 0 ? "up" : "down"} />
        <Metric label="Realized P&L" value={signedShortMoney(game.player.realizedPnl)} tone={game.player.realizedPnl >= 0 ? "up" : "down"} />
        <Metric label="Account Heat" value={`${game.player.accountHeat.toFixed(0)} / 100`} tone="heat" />
        <Metric label="Influence" value={game.player.influence.toFixed(0)} />
        <Metric label="Reputation" value={game.player.reputation.toFixed(0)} />
      </section>

      <main className="main-grid">
        <MarketOverview
          game={game}
          selectedStockId={selectedStockId}
          simpleMode={simpleMarketMode}
          onSimpleModeChange={setSimpleMarketMode}
          onSelect={setSelectedStockId}
        />
        <StockWorkspace
          game={game}
          stock={selectedStock}
          trace={selectedTrace}
          recentResults={recentResults}
          playerFillHistory={playerFillHistory}
          showTradeMarks={showTradeMarks}
          onToggleTradeMarks={() => setShowTradeMarks((value) => !value)}
          kLineRange={kLineRange}
          kLineAxisMode={kLineAxisMode}
          onKLineRangeChange={setKLineRange}
          onKLineAxisModeChange={setKLineAxisMode}
        />
        <aside className="side-stack">
          <OrderBook depth={depth} stock={selectedStock} />
          <OrderTicket
            game={game}
            stock={selectedStock}
            conditionalOrders={conditionalOrders.filter((order) => order.stockId === selectedStock.id)}
            side={tradeSide}
            quantity={quantity}
            limitPrice={limitPrice}
            message={ticketMessage}
            pendingCount={pendingActions.length}
            onSideChange={setTradeSide}
            onQuantityChange={setQuantity}
            onLimitPriceChange={setLimitPrice}
            onSubmit={submitOrder}
            onSubmitConditional={submitConditionalOrder}
            onCancelConditional={cancelConditionalOrder}
            onCancelAuctionOrder={cancelAuctionOrder}
          />
          <WhaleFeed rows={whaleRows} />
        </aside>
        <LowerPanel mode={lowerPanelMode} game={game} stock={selectedStock} />
      </main>
      {shortcutHelpOpen ? (
        <ShortcutHelp onClose={closeShortcutHelp} firstVisit />
      ) : null}
      <OrderToastStack toasts={orderToasts} />
    </div>
  );
}

function ShortcutHelp({ onClose, firstVisit = false }: { onClose: () => void; firstVisit?: boolean }) {
  const shortcuts = [
    ["Space", "播放 / 暂停"],
    ["F", "快进下一日"],
    ["J / K", "切换上一只 / 下一只股票"],
    ["1 / 2 / 3", "切换市场 / 基本面 / 持仓页面"],
    ["B / S", "切换买入 / 卖出"],
    ["⌘ / Ctrl + Enter", "提交订单"],
    ["Esc", "关闭弹层"],
    ["?", "打开快捷键帮助"],
  ];

  return (
    <div className="shortcut-overlay" role="presentation">
      <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-dialog-title">
        <div className="shortcut-dialog__topline">
          <span>{firstVisit ? "Welcome to STONKS" : "Keyboard map"}</span>
          <button type="button" className="shortcut-dialog__close" onClick={onClose} autoFocus aria-label="关闭快捷键帮助">
            Esc
          </button>
        </div>
        <h2 id="shortcut-dialog-title">用键盘掌控市场。</h2>
        {firstVisit ? <p className="shortcut-dialog__intro">第一次进入？记住按 <kbd>?</kbd>，随时呼出这张快捷键提示。</p> : null}
        <div className="shortcut-list">
          {shortcuts.map(([key, label]) => (
            <div className="shortcut-row" key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <button type="button" className="shortcut-dialog__confirm" onClick={onClose}>
          {firstVisit ? "开始交易" : "关闭提示"}
        </button>
      </section>
    </div>
  );
}

function MarketOverview({
  game,
  selectedStockId,
  simpleMode,
  onSimpleModeChange,
  onSelect
}: {
  game: GameState;
  selectedStockId: StockId;
  simpleMode: boolean;
  onSimpleModeChange: (value: boolean) => void;
  onSelect: (stockId: StockId) => void;
}) {
  return (
    <section className="panel market-panel">
      <div className="panel-title market-head">
        <div>
          <BarChart3 size={15} />
          <span>Market Overview (A-Share + ETF)</span>
        </div>
        <label className="simple-toggle">
          <input type="checkbox" checked={simpleMode} onChange={(event) => onSimpleModeChange(event.target.checked)} />
          <span>Simple</span>
        </label>
      </div>
      {simpleMode ? (
        <div className="simple-market-list">
          {stockIds.map((stockId) => {
            const stock = game.stocks[stockId];
            const change = dailyChangePct(stock);
            const tone = marketTone(change);
            return (
              <button
                key={stock.id}
                className={stock.id === selectedStockId ? "simple-market-row selected" : "simple-market-row"}
                onClick={() => onSelect(stock.id)}
                type="button"
              >
                <div className="simple-market-info">
                  <strong>{stock.id}</strong>
                  <span>{stock.name}</span>
                  <em>{titleCase(stock.sector)}</em>
                </div>
                <MiniIntradaySparkline
                  chart={stock.chart}
                  previousClose={stock.previousClose}
                  currentDay={game.day}
                />
                <div className={`simple-market-price ${tone}`}>
                  <strong>{stock.price.toFixed(2)}</strong>
                  <span>{signedPct(change)}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="market-table">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Sector</th>
                <th>Board</th>
                <th>Price</th>
                <th>Chg</th>
                <th>State</th>
                <th>Attn</th>
                <th>Sent</th>
                <th>Heat</th>
                <th>Turn</th>
                <th>Vol</th>
              </tr>
            </thead>
            <tbody>
              {stockIds.map((stockId) => {
                const stock = game.stocks[stockId];
                const change = dailyChangePct(stock);
                return (
                  <tr
                    key={stock.id}
                    className={stock.id === selectedStockId ? "selected" : ""}
                    onClick={() => onSelect(stock.id)}
                  >
                    <td>
                      <strong>{stock.id}</strong>
                      <span>{stock.name}</span>
                    </td>
                    <td>{sectorLabel(stock.sector)}</td>
                    <td>{boardShortLabel(stock.boardType)}</td>
                    <td>{stock.price.toFixed(2)}</td>
                    <td className={change >= 0 ? "tone-up" : "tone-down"}>{signedPct(change)}</td>
                    <td>
                      <span className={`state-chip ${stateClass(stock.boardState)}`}>{boardStateLabel(stock.boardState)}</span>
                    </td>
                    <td>{stock.attention.toFixed(0)}</td>
                    <td>{stock.sentiment.toFixed(0)}</td>
                    <td className={stock.heat > 65 ? "tone-heat" : ""}>{stock.heat.toFixed(0)}</td>
                    <td>{compactMoney(stock.turnover)}</td>
                    <td>{shortShares(stock.volume)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-foot">
        <span>Turnover in CNY</span>
        <span>Volume in shares</span>
      </div>
    </section>
  );
}

function StockWorkspace({
  game,
  stock,
  trace,
  recentResults,
  playerFillHistory,
  showTradeMarks,
  onToggleTradeMarks,
  kLineRange,
  kLineAxisMode,
  onKLineRangeChange,
  onKLineAxisModeChange
}: {
  game: GameState;
  stock: Stock;
  trace?: StockTraceView;
  recentResults: TickResult[];
  playerFillHistory: PlayerFillRecord[];
  showTradeMarks: boolean;
  onToggleTradeMarks: () => void;
  kLineRange: KLineRange;
  kLineAxisMode: KLineAxisMode;
  onKLineRangeChange: (range: KLineRange) => void;
  onKLineAxisModeChange: (mode: KLineAxisMode) => void;
}) {
  const position = game.player.positions[stock.id];
  const valuation = getValuationSnapshot(stock);
  const activeNews = game.news.filter((news) => news.scope === "market" || news.targetId === stock.id || news.targetId === stock.sector);
  const tradeMarks = useMemo(() => createTradeMarks(recentResults, stock.id, game.day), [game.day, recentResults, stock.id]);
  const dailyTradeMarks = useMemo(() => createDailyTradeMarks(playerFillHistory, stock.id), [playerFillHistory, stock.id]);

  return (
    <section className="panel stock-panel">
      <div className="stock-header">
        <div>
          <div className="stock-title-line">
            <Star size={18} />
            <h1>{stock.id}</h1>
            <span className="board-badge">{boardLabel(stock.boardType)}</span>
          </div>
          <div className="muted">{stock.name}</div>
          <div className={`price-line tone-${marketTone(dailyChangePct(stock))}`}>
            {stock.price.toFixed(2)}
            <span>{signedPriceMove(stock.price - stock.previousClose)} ({signedPct(dailyChangePct(stock))})</span>
          </div>
        </div>
        <div className="info-matrix">
          <InfoCell label="Market Cap" value={shortMoney(stock.marketCap)} />
          <InfoCell label="P/E" value={stock.pe.toFixed(1)} />
          <InfoCell label="Fair P/E" value={stock.fairPe.toFixed(1)} />
          <InfoCell label="Turnover" value={shortMoney(stock.turnover)} />
          <InfoCell label="Liquidity" value={shortMoney(stock.currentLiquidity)} />
          <InfoCell label="Prev Close" value={stock.previousClose.toFixed(2)} />
          <InfoCell label="Upper Limit" value={getUpperLimit(stock).toFixed(2)} tone="up" />
          <InfoCell label="Lower Limit" value={getLowerLimit(stock).toFixed(2)} tone="down" />
          <InfoCell label="Valuation" value={valuation.overvalued ? "Rich" : valuation.undervalued ? "Cheap" : "Fair"} />
        </div>
      </div>

      <div className="signal-row">
        <Signal label="Buy Pressure" value={trace ? shortMoney(trace.pressure.buyPressure) : "-"} tone="up" />
        <Signal label="Sell Pressure" value={trace ? shortMoney(trace.pressure.sellPressure) : "-"} tone="down" />
        <Signal label="Buy Queue" value={shortMoney(stock.buyQueue)} tone="up" />
        <Signal label="Sell Queue" value={shortMoney(stock.sellQueue)} tone="down" />
        <Signal label="Board Strength" value={stock.boardStrength.toFixed(0)} />
        <Signal label="Depth" value={shortMoney(trace?.effectiveDepth ?? calculateEffectiveDepth(stock))} />
      </div>

      <div className="chart-grid">
        <div className="chart-card">
          <div className="chart-head">
            <strong>Intraday</strong>
            <span>09:30-15:00 / {GAME_CONFIG.ticksPerDay} ticks</span>
          </div>
          <IntradayChart
            chart={stock.chart}
            previousClose={stock.previousClose}
            currentDay={game.day}
            tradeMarks={tradeMarks}
            showTradeMarks={showTradeMarks}
            onToggleTradeMarks={onToggleTradeMarks}
          />
        </div>
        <div className="chart-card">
          <div className="chart-head">
            <strong>K-Line</strong>
            <div className="chart-tools">
              <div className="range-tabs" aria-label="K-line range">
                {([5, 20, 60, "all"] as KLineRange[]).map((range) => (
                  <button
                    className={kLineRange === range ? "active" : ""}
                    key={range}
                    onClick={() => onKLineRangeChange(range)}
                    type="button"
                  >
                    {range === "all" ? "All" : `${range}D`}
                  </button>
                ))}
              </div>
              <select
                className="axis-select"
                value={kLineAxisMode}
                onChange={(event) => onKLineAxisModeChange(event.target.value as KLineAxisMode)}
                aria-label="K-line price axis"
              >
                <option value="auto">Auto</option>
                <option value="pct10">10%</option>
                <option value="pct20">20%</option>
              </select>
            </div>
          </div>
          <KLineChart
            candles={stock.dailyCandles}
            range={kLineRange}
            axisMode={kLineAxisMode}
            currentDay={game.day}
            tradeMarks={dailyTradeMarks}
            showTradeMarks={showTradeMarks}
          />
        </div>
      </div>

      <div className="micro-grid">
        <InfoCell label="Retail Attention" value={stock.retail.attention.toFixed(0)} />
        <InfoCell label="Retail Fear" value={stock.retail.fear.toFixed(0)} />
        <InfoCell label="Retail Greed" value={stock.retail.greed.toFixed(0)} />
        <InfoCell label="Sector Sentiment" value={game.sectors[stock.sector].sentiment.toFixed(0)} />
        <InfoCell label="Stock Heat" value={stock.heat.toFixed(0)} tone="heat" />
        <InfoCell label="Position" value={position ? shortShares(position.totalShares) : "0"} />
        <InfoCell label="Sellable" value={position ? shortShares(position.sellableShares) : "0"} />
        <InfoCell label="Locked" value={position ? shortShares(position.lockedShares) : "0"} />
        <InfoCell label="Average Cost" value={position ? position.avgCost.toFixed(2) : "-"} />
        <InfoCell label="Active News" value={activeNews.length.toString()} />
        <InfoCell
          label={stock.assetType === "etf" ? "ETF Premium" : "Whale Prints"}
          value={stock.assetType === "etf" ? formatEtfPremium(stock) : recentResults.reduce((total, result) => total + result.whaleTrades.filter((trade) => trade.stockId === stock.id).length, 0).toString()}
        />
        <InfoCell label="Quant Activity" value={quantHint(stock.quantPresence, trace)} />
      </div>
    </section>
  );
}

function OrderBook({ depth, stock }: { depth: ReturnType<typeof createMarketDepth>; stock: Stock }) {
  const [expanded, setExpanded] = useState(false);
  const auctionActive = !stock.auction.settled && (stock.auction.phase === "cancelable" || stock.auction.phase === "locked");
  const asks = depth.askLevels.slice(0, 10);
  const bids = depth.bidLevels.slice(0, 10);
  const bestAsk = asks[0];
  const bestBid = bids[0];

  return (
    <section className="panel side-panel order-book compact">
      <div className="panel-title book-title">
        <div>Order Book</div>
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? "Hide" : "10L"}
        </button>
      </div>
      {auctionActive ? (
        <div className="book-compact auction-compact">
          <div className="book-best">
            <span>{titleCase(stock.auction.phase)}</span>
            <strong>{stock.auction.referencePrice.toFixed(2)}</strong>
            <em>Ref price</em>
          </div>
          <div className="book-best">
            <span>Match</span>
            <strong>{shortShares(stock.auction.referenceMatchedShares)}</strong>
            <em>{shortMoney(stock.auction.referenceMatchedNotional)}</em>
          </div>
        </div>
      ) : (
        <div className="book-compact">
          <div className="book-best ask">
            <span>Ask 1</span>
            <strong>{bestAsk ? bestAsk.price.toFixed(2) : "-"}</strong>
            <em>{bestAsk ? shortMoney(bestAsk.availableNotional) : "-"}</em>
          </div>
          <div className="book-best bid">
            <span>Bid 1</span>
            <strong>{bestBid ? bestBid.price.toFixed(2) : "-"}</strong>
            <em>{bestBid ? shortMoney(bestBid.availableNotional) : "-"}</em>
          </div>
        </div>
      )}
      {expanded ? (
        <div className="book-popover">
          {auctionActive ? (
            <div className="book-table">
              <div className="data-row"><span>Buy imbalance</span><strong className="tone-up">{shortShares(Math.max(0, stock.auction.imbalanceShares))}</strong></div>
              <div className="data-row"><span>Sell imbalance</span><strong className="tone-down">{shortShares(Math.max(0, -stock.auction.imbalanceShares))}</strong></div>
              <div className="data-row"><span>Auction orders</span><strong>{stock.auction.orders.filter((order) => order.status === "open").length.toString()}</strong></div>
            </div>
          ) : (
          <div className="book-table">
            <div className="book-row book-head">
              <span>Level</span>
              <span>Price</span>
              <span>Available</span>
            </div>
            {[...asks].reverse().map((level, index) => (
              <div className="book-row ask" key={`ask-${level.price}-${index}`}>
                <span>Ask {asks.length - index}</span>
                <strong>{level.price.toFixed(2)}</strong>
                <span>{shortMoney(level.availableNotional)}</span>
              </div>
            ))}
            <div className="spread-line">
              <span>Spread</span>
              <strong>{spread(depth).toFixed(2)}</strong>
            </div>
            {bids.map((level, index) => (
              <div className="book-row bid" key={`bid-${level.price}-${index}`}>
                <span>Bid {index + 1}</span>
                <strong>{level.price.toFixed(2)}</strong>
                <span>{shortMoney(level.availableNotional)}</span>
              </div>
            ))}
          </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function OrderTicket({
  game,
  stock,
  conditionalOrders,
  side,
  quantity,
  limitPrice,
  message,
  pendingCount,
  onSideChange,
  onQuantityChange,
  onLimitPriceChange,
  onSubmit,
  onSubmitConditional,
  onCancelConditional,
  onCancelAuctionOrder
}: {
  game: GameState;
  stock: Stock;
  conditionalOrders: ConditionalOrder[];
  side: TradeSide;
  quantity: string;
  limitPrice: string;
  message: string;
  pendingCount: number;
  onSideChange: (side: TradeSide) => void;
  onQuantityChange: (value: string) => void;
  onLimitPriceChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitConditional: (order: Omit<ConditionalOrder, "id" | "stockId" | "createdDay" | "createdTick">) => void;
  onCancelConditional: (orderId: string) => void;
  onCancelAuctionOrder: (orderId: string) => void;
}) {
  const [ticketMode, setTicketMode] = useState<"normal" | "conditional">("normal");
  const [conditionType, setConditionType] = useState<ConditionSpec["type"]>("tick");
  const [timeTarget, setTimeTarget] = useState(() => Math.max(1, game.tick + 10).toString());
  const [priceOperator, setPriceOperator] = useState<"above" | "below">("above");
  const [triggerPrice, setTriggerPrice] = useState(() => stock.price.toFixed(2));
  const shares = Math.max(0, Math.floor(Number(quantity) || 0));
  const price = Math.max(0, Number(limitPrice) || 0);
  const notional = shares * price;
  const position = game.player.positions[stock.id];
  const canAuctionSubmit = canSubmitAuctionOrder(game.tick);
  const canAuctionCancel = canCancelAuctionOrder(game.tick);
  const canContinuousTrade = game.phase === "intraday" || game.phase === "closingAuction";
  const canTrade = canAuctionSubmit || canContinuousTrade;
  const playerAuctionOrders = stock.auction.orders.filter((order) => order.owner === "player" && order.status === "open");
  const applyPositionFraction = (fraction: number) => {
    if (side === "buy") {
      const referencePrice = price > 0 ? price : stock.price;
      const targetShares = referencePrice > 0 ? Math.floor((game.player.cash * fraction) / referencePrice) : 0;
      onQuantityChange(targetShares.toString());
      return;
    }

    const targetShares = Math.floor((position?.sellableShares ?? 0) * fraction);
    onQuantityChange(targetShares.toString());
  };
  const applyPrice = (nextPrice: number) => {
    onLimitPriceChange(Math.max(0, nextPrice).toFixed(2));
  };
  useEffect(() => {
    setTriggerPrice(stock.price.toFixed(2));
  }, [stock.id]);
  const submitConditional = () => {
    if (shares <= 0 || price <= 0) return;
    const numericTarget = Math.max(0, Math.floor(Number(timeTarget) || 0));
    const numericTriggerPrice = Math.max(0, Number(triggerPrice) || 0);
    const condition: ConditionSpec =
      conditionType === "day"
        ? { type: "day", targetDay: Math.max(1, numericTarget) }
        : conditionType === "tick"
          ? { type: "tick", targetTick: numericTarget }
          : { type: "price", operator: priceOperator, triggerPrice: numericTriggerPrice };
    if (condition.type === "price" && condition.triggerPrice <= 0) return;
    onSubmitConditional({
      side,
      shares,
      limitPrice: price,
      condition
    });
  };

  return (
    <section className="panel side-panel ticket-panel">
      <PanelTitle title="Order Ticket" icon={<Wallet size={14} />} />
      <div className="ticket-body">
        <div className="ticket-tabs" aria-label="Order mode">
          <button className={ticketMode === "normal" ? "active" : ""} type="button" onClick={() => setTicketMode("normal")}>Normal</button>
          <button className={ticketMode === "conditional" ? "active" : ""} type="button" onClick={() => setTicketMode("conditional")}>Conditional</button>
        </div>
        <div className="segmented">
          <button
            aria-pressed={side === "buy"}
            className={side === "buy" ? "buy active" : "buy"}
            onClick={() => onSideChange("buy")}
            type="button"
          >
            Buy <kbd>B</kbd>
          </button>
          <button
            aria-pressed={side === "sell"}
            className={side === "sell" ? "sell active" : "sell"}
            onClick={() => onSideChange("sell")}
            type="button"
          >
            Sell <kbd>S</kbd>
          </button>
        </div>
        <div className="field-row">
          <span>Quantity (Shares)</span>
          <QuickPicker
            label="Position size"
            trigger="%"
            options={[
              { label: "1/10", onSelect: () => applyPositionFraction(0.1) },
              { label: "1/4", onSelect: () => applyPositionFraction(0.25) },
              { label: "1/2", onSelect: () => applyPositionFraction(0.5) },
              { label: "All", onSelect: () => applyPositionFraction(1) }
            ]}
          />
          <input inputMode="numeric" value={quantity} onChange={(event) => onQuantityChange(event.target.value)} />
        </div>
        <div className="field-row">
          <span>Limit Price (CNY)</span>
          <QuickPicker
            label="Price presets"
            trigger="P"
            options={[
              { label: "Current", onSelect: () => applyPrice(stock.price) },
              { label: "Open", onSelect: () => applyPrice(stock.open) },
              { label: "Limit Up", onSelect: () => applyPrice(getUpperLimit(stock)) },
              { label: "Limit Down", onSelect: () => applyPrice(getLowerLimit(stock)) }
            ]}
          />
          <input inputMode="decimal" value={limitPrice} onChange={(event) => onLimitPriceChange(event.target.value)} />
        </div>
        <div className="ticket-summary">
          <div>
            <span>Est. Notional</span>
            <strong className={side === "buy" ? "tone-up" : "tone-down"}>{money(notional)}</strong>
          </div>
          <div>
            <span>{side === "buy" ? "Available Cash" : "Sellable Shares"}</span>
            <strong>{side === "buy" ? money(game.player.cash) : shortShares(position?.sellableShares ?? 0)}</strong>
          </div>
        </div>
        {ticketMode === "conditional" ? (
          <div className="condition-box">
            <div className="condition-row">
              <select value={conditionType} onChange={(event) => setConditionType(event.target.value as ConditionSpec["type"])} aria-label="Condition type">
                <option value="tick">Tick &gt;=</option>
                <option value="day">Day &gt;=</option>
                <option value="price">Price</option>
              </select>
              {conditionType === "price" ? (
                <>
                  <select value={priceOperator} onChange={(event) => setPriceOperator(event.target.value as "above" | "below")} aria-label="Price trigger direction">
                    <option value="above">Above</option>
                    <option value="below">Below</option>
                  </select>
                  <input inputMode="decimal" value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} />
                </>
              ) : (
                <input inputMode="numeric" value={timeTarget} onChange={(event) => setTimeTarget(event.target.value)} />
              )}
            </div>
          </div>
        ) : null}
        <button className={`submit-order ${side}`} onClick={ticketMode === "normal" ? onSubmit : submitConditional} disabled={ticketMode === "normal" && !canTrade} title="提交订单 · Cmd/Ctrl + Enter">
          {ticketMode === "normal"
            ? canTrade ? `${canAuctionSubmit ? "Auction" : "Queue"} ${side === "buy" ? "Buy" : "Sell"} Order` : "Trading Closed"
            : `Arm Conditional ${side === "buy" ? "Buy" : "Sell"}`}
          {ticketMode === "normal" ? <kbd>⌘ / Ctrl + Enter</kbd> : null}
        </button>
        <div className="ticket-message">{message || `${stock.id} ${game.phase}`}</div>
        <div className="pending-line">{pendingCount > 0 ? `${pendingCount} queued for next tick` : canAuctionSubmit ? "Auction orders join the indicative book." : "Orders execute on the next timed tick."}</div>
        {playerAuctionOrders.length > 0 ? (
          <div className="conditional-list">
            {playerAuctionOrders.map((order) => (
              <div className={`conditional-item ${order.side}`} key={order.id}>
                <span>{order.side.toUpperCase()} {shortShares(order.remainingShares)} @ {order.price.toFixed(2)}</span>
                <strong>{canAuctionCancel && order.cancellable ? "Cancelable" : "Locked"}</strong>
                {canAuctionCancel && order.cancellable ? (
                  <button type="button" onClick={() => onCancelAuctionOrder(order.id)} aria-label="Cancel auction order">撤</button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {conditionalOrders.length > 0 ? (
          <div className="conditional-list">
            {conditionalOrders.map((order) => (
              <div className={`conditional-item ${order.side}`} key={order.id}>
                <span>{order.side.toUpperCase()} {shortShares(order.shares)} @ {order.limitPrice.toFixed(2)}{order.working ? " working" : ""}</span>
                <strong>{formatCondition(order.condition)}</strong>
                <button type="button" onClick={() => onCancelConditional(order.id)} aria-label="Cancel conditional order">撤</button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WhaleIndexBar({ index }: { index: WhaleIndexSnapshot }) {
  return (
    <div className="whale-index">
      <div className="whale-index-label">Whale Index</div>
      <div className={`whale-index-value tone-${index.tone}`}>{index.value.toFixed(2)}</div>
      <div className={`whale-index-change tone-${index.tone}`}>
        <strong>{index.change >= 0 ? "+" : ""}{index.change.toFixed(2)}</strong>
        <span>{index.changePct >= 0 ? "+" : ""}{index.changePct.toFixed(2)}%</span>
      </div>
    </div>
  );
}

function AutosaveStatus({
  status,
  onSave,
  onClear
}: {
  status: SaveStatus;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className={`autosave-status ${status.tone}`}>
      <span title={status.label}>{status.label}</span>
      <button type="button" onClick={onSave}>Save</button>
      <button type="button" onClick={onClear}>Clear</button>
    </div>
  );
}

function OrderToastStack({ toasts }: { toasts: OrderToast[] }) {
  if (toasts.length === 0) return null;

  return (
    <div className="order-toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`order-toast ${toast.kind} ${toast.side}`} key={toast.id}>
          <strong>{toast.kind === "success" ? (toast.side === "buy" ? "Buy Filled" : "Sell Filled") : "Order Failed"}</strong>
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

function QuickPicker({
  label,
  trigger,
  options
}: {
  label: string;
  trigger: string;
  options: Array<{ label: string; onSelect: () => void }>;
}) {
  return (
    <div className="quick-picker">
      <button className="quick-trigger" type="button" aria-label={label} title={label}>
        {trigger}
      </button>
      <div className="quick-popover" role="menu" aria-label={label}>
        {options.map((option) => (
          <button key={option.label} type="button" onClick={option.onSelect} role="menuitem">
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniIntradaySparkline({
  chart,
  previousClose,
  currentDay
}: {
  chart: TickPrice[];
  previousClose: number;
  currentDay: number;
}) {
  const points = chart.filter((point) => point.day === currentDay);
  const width = 170;
  const height = 48;
  const values = points.length > 0 ? points : [{ day: currentDay, tick: 0, price: previousClose, boardState: "loose" as BoardState }];
  const prices = values.map((point) => point.price);
  const min = Math.min(...prices, previousClose);
  const max = Math.max(...prices, previousClose);
  const span = Math.max(0.01, max - min);
  const pad = span * 0.16;
  const low = min - pad;
  const high = max + pad;
  const lastTickIndex = Math.max(1, GAME_CONFIG.ticksPerDay - 1);
  const xForTick = (tick: number) => (Math.min(lastTickIndex, Math.max(0, tick)) / lastTickIndex) * width;
  const yFor = (price: number) => height - ((price - low) / (high - low)) * height;
  const line = values.map((point) => `${xForTick(point.tick).toFixed(1)},${yFor(point.price).toFixed(1)}`).join(" ");
  const fill = `0,${height} ${line} ${xForTick(values.at(-1)?.tick ?? 0).toFixed(1)},${height}`;
  const up = (values.at(-1)?.price ?? previousClose) >= previousClose;
  const baseline = yFor(previousClose);

  return (
    <svg className={up ? "mini-sparkline up" : "mini-sparkline down"} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mini intraday chart">
      <line x1="0" x2={width} y1={baseline} y2={baseline} className="mini-baseline" />
      <polyline points={fill} className="mini-area" />
      <polyline points={line} className="mini-line" />
    </svg>
  );
}

function WhaleFeed({ rows }: { rows: WhaleFeedRow[] }) {
  return (
    <section className="panel side-panel whale-feed">
      <PanelTitle title="Whale Trades (Live)" />
      <div className="whale-rows">
        <div className="whale-row whale-head">
          <span>Time</span>
          <span>Whale</span>
          <span>Side</span>
          <span>Stock</span>
          <span>Shares</span>
          <span>Avg</span>
          <span>Intent</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty-state">No whale prints yet.</div>
        ) : (
          rows.map((row) => (
            <div className="whale-row" key={row.key}>
              <span>D{row.day} T{row.tick}</span>
              <strong>{row.whale}</strong>
              <span className={row.side === "buy" ? "tone-up" : "tone-down"}>{titleCase(row.side)}</span>
              <span>{row.stockId}</span>
              <span>{shortShares(row.shares)}</span>
              <span>{row.avgPrice.toFixed(2)}</span>
              <span>{titleCase(row.intention)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function LowerPanel({ mode, game, stock }: { mode: "fundamentals" | "portfolio"; game: GameState; stock: Stock }) {
  return (
    <section className="panel lower-panel">
      {mode === "portfolio" ? <PortfolioPanel game={game} /> : <FundamentalsPanel game={game} stock={stock} />}
    </section>
  );
}

function FundamentalsPanel({ game, stock }: { game: GameState; stock: Stock }) {
  const [activeTab, setActiveTab] = useState<"fundamentals" | "financials" | "news" | "notes">("fundamentals");
  const valuation = getValuationSnapshot(stock);
  const news = game.news.filter((item) => item.scope === "market" || item.targetId === stock.id || item.targetId === stock.sector);

  return (
    <>
      <div className="lower-tabs">
        <button type="button" className={activeTab === "fundamentals" ? "active" : ""} onClick={() => setActiveTab("fundamentals")}>Fundamentals</button>
        <button type="button" className={activeTab === "financials" ? "active" : ""} onClick={() => setActiveTab("financials")}>Financials</button>
        <button type="button" className={activeTab === "news" ? "active" : ""} onClick={() => setActiveTab("news")}>News</button>
        <button type="button" className={activeTab === "notes" ? "active" : ""} onClick={() => setActiveTab("notes")}>Notes</button>
      </div>
      {activeTab === "news" ? (
        <ActiveNewsPanel game={game} stock={stock} relevantNews={news} />
      ) : activeTab === "notes" ? (
        <div className="news-grid">
          <div className="data-card news-board wide">
            <h3>Recent Market Notes</h3>
            {game.eventLog.slice(-12).reverse().map((event) => (
              <div className="news-line" key={`${event.day}-${event.tick}-${event.message}`}>
                <strong>{event.message}</strong>
                <span>Day {event.day} | tick {event.tick} | {titleCase(event.type)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="fundamentals-grid">
          <DataCard title="Valuation" rows={[
            ["P/E", stock.pe.toFixed(1)],
            ["Fair P/E", stock.fairPe.toFixed(1)],
            ["Fair Value", valuation.fairValue.toFixed(2)],
            ["Profit Yield", `${valuation.profitYield.toFixed(2)}%`]
          ]} />
          <DataCard title="Profitability" rows={[
            ["Net Profit", shortMoney(stock.netProfit)],
            ["EPS", stock.earningsPerShare.toFixed(2)],
            ["Growth", signedPct(stock.profitGrowth)],
            ["Health", stock.financialHealth.toFixed(0)]
          ]} />
          <DataCard title={activeTab === "financials" ? "Balance Texture" : "Market Texture"} rows={stock.assetType === "etf" ? [
            ["NAV", (stock.etf?.nav ?? stock.price).toFixed(2)],
            ["Premium", formatEtfPremium(stock)],
            ["Components", (stock.etf?.components.length ?? 0).toString()],
            ["Liquidity", shortMoney(stock.currentLiquidity)]
          ] : [
            ["Cap Class", titleCase(getMarketCapClass(stock))],
            ["Float", shortShares(stock.floatShares)],
            ["Liquidity", shortMoney(stock.currentLiquidity)],
            ["Turnover", shortMoney(stock.turnover)]
          ]} />
          <CostDistributionCard stock={stock} />
          <div className="data-card news-card">
            <h3>Active News</h3>
            {news.length === 0 ? (
              <p className="muted">No active news for this stock.</p>
            ) : (
              news.slice(0, 3).map((item) => <NewsLine item={item} game={game} key={item.id} />)
            )}
          </div>
        </div>
      )}
    </>
  );
}

function ActiveNewsPanel({ game, stock, relevantNews }: { game: GameState; stock: Stock; relevantNews: NewsItem[] }) {
  const activeNews = [...game.news].sort((first, second) => getNewsSortScore(second, stock) - getNewsSortScore(first, stock));

  return (
    <div className="news-grid">
      <div className="data-card news-board">
        <h3>Relevant Active News</h3>
        {relevantNews.length === 0 ? (
          <p className="muted">No active news is attached to this stock, its sector, or the broad market.</p>
        ) : (
          relevantNews.map((item) => <NewsLine item={item} game={game} key={item.id} />)
        )}
      </div>
      <div className="data-card news-board">
        <h3>Market News Tape</h3>
        {activeNews.length === 0 ? (
          <p className="muted">No active news.</p>
        ) : (
          activeNews.map((item) => <NewsLine item={item} game={game} compact key={item.id} />)
        )}
      </div>
    </div>
  );
}

function NewsLine({ item, game, compact = false }: { item: NewsItem; game: GameState; compact?: boolean }) {
  return (
    <div className={`news-line ${compact ? "compact" : ""}`}>
      <strong>{item.title}</strong>
      <span>
        {formatNewsPolarity(item)} | {titleCase(item.source)} | {formatNewsTarget(item, game)} | strength {item.strength} | credibility {item.credibility} | {item.remainingDays}d
      </span>
    </div>
  );
}

function getNewsSortScore(item: NewsItem, stock: Stock): number {
  const relevance = item.targetId === stock.id ? 30 : item.targetId === stock.sector ? 20 : item.scope === "market" ? 10 : 0;
  return relevance + item.strength * 0.5 + item.credibility * 0.15 + item.heatImpact;
}

function formatNewsPolarity(item: NewsItem): string {
  return item.polarity > 0 ? "Positive" : item.polarity < 0 ? "Negative" : "Neutral";
}

function formatNewsTarget(item: NewsItem, game: GameState): string {
  if (item.scope === "market") return "Market";
  if (item.scope === "sector" && item.targetId && item.targetId in game.sectors) return game.sectors[item.targetId as keyof typeof game.sectors].name;
  if (item.scope === "stock" && item.targetId && item.targetId in game.stocks) return game.stocks[item.targetId as StockId].name;
  return item.targetId ?? titleCase(item.scope);
}

function PortfolioPanel({ game }: { game: GameState }) {
  const positions = Object.values(game.player.positions).filter(Boolean);
  return (
    <>
      <div className="lower-tabs">
        <button className="active">Portfolio</button>
        <button>Resting Orders</button>
        <button>Bear Contracts</button>
      </div>
      <div className="portfolio-grid">
        <table className="portfolio-table">
          <thead>
            <tr>
              <th>Stock</th>
              <th>Shares Held</th>
              <th>Sellable</th>
              <th>T+1 Locked</th>
              <th>Average Cost</th>
              <th>Current Price</th>
              <th>Unrealized P&L</th>
              <th>Realized P&L</th>
              <th>Liquidity Risk</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-row">No positions yet.</td>
              </tr>
            ) : (
              positions.map((position) => {
                if (!position) return null;
                const stock = game.stocks[position.stockId];
                const unrealized = (stock.price - position.avgCost) * position.totalShares;
                return (
                  <tr key={position.stockId}>
                    <td><strong>{position.stockId}</strong></td>
                    <td>{shortShares(position.totalShares)}</td>
                    <td>{shortShares(position.sellableShares)}</td>
                    <td>{shortShares(position.lockedShares)}</td>
                    <td>{position.avgCost.toFixed(2)}</td>
                    <td>{stock.price.toFixed(2)}</td>
                    <td className={unrealized >= 0 ? "tone-up" : "tone-down"}>{signedMoney(unrealized)}</td>
                    <td className={position.realizedPnl >= 0 ? "tone-up" : "tone-down"}>{signedMoney(position.realizedPnl)}</td>
                    <td>{liquidityRisk(stock)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        <div className="resting-list">
          <h3>Resting Orders</h3>
          {game.player.activeOrders.length === 0 ? (
            <p className="muted">No resting orders.</p>
          ) : (
            game.player.activeOrders.map((order) => (
              <div className="resting-item" key={order.id}>
                <strong>{order.stockId}</strong>
                <span>{titleCase(order.side)} {money(order.amountCash ?? 0)}</span>
                <span>{order.limitPrice ? `limit ${order.limitPrice.toFixed(2)}` : "marketable"}</span>
                <span>{order.remainingTicks ?? 0} ticks</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function IntradayChart({
  chart,
  previousClose,
  currentDay,
  tradeMarks,
  showTradeMarks,
  onToggleTradeMarks
}: {
  chart: TickPrice[];
  previousClose: number;
  currentDay: number;
  tradeMarks: TradeMark[];
  showTradeMarks: boolean;
  onToggleTradeMarks: () => void;
}) {
  const [hover, setHover] = useState<ChartHover | undefined>();
  const points = chart.filter((point) => point.day === currentDay);
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices, previousClose);
  const max = Math.max(...prices, previousClose);
  const span = Math.max(0.01, max - min);
  const pad = span * 0.16;
  const low = min - pad;
  const high = max + pad;
  const width = 360;
  const height = 172;
  const lastTickIndex = Math.max(1, GAME_CONFIG.ticksPerDay - 1);
  const xForTick = (tick: number) => (Math.min(lastTickIndex, Math.max(0, tick)) / lastTickIndex) * width;
  const xFor = (point: TickPrice) => xForTick(point.tick);
  const yFor = (price: number) => height - ((price - low) / (high - low)) * height;
  const priceForY = (y: number) => high - (y / height) * (high - low);
  const path = points.map((point) => `${xFor(point).toFixed(1)},${yFor(point.price).toFixed(1)}`).join(" ");
  const baseline = yFor(previousClose);
  const last = points[points.length - 1];
  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(width, Math.max(0, ((event.clientX - rect.left) / rect.width) * width));
    const y = Math.min(height, Math.max(0, ((event.clientY - rect.top) / rect.height) * height));
    const tick = Math.round((x / width) * lastTickIndex);
    const point = findNearestTickPoint(points, tick);
    setHover({
      x,
      y,
      tick,
      coordPrice: priceForY(y),
      point
    });
  };

  return (
    <div className="intraday-frame">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Intraday price chart"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(undefined)}
      >
        <GridLines width={width} height={height} xLines={[0.25, 0.5, 0.75]} />
        <line x1="0" x2={width} y1={baseline} y2={baseline} className="baseline" />
        <polyline points={path} className="intraday-line" />
        <polyline
          points={points.filter((point) => point.kind === "auctionIndicative").map((point) => `${xFor(point).toFixed(1)},${yFor(point.price).toFixed(1)}`).join(" ")}
          className="auction-indicative-line"
        />
        {points.map((point) =>
          point.boardState === "sealedLimitUp" || point.boardState === "limitDown" ? (
            <circle
              key={`${point.day}-${point.tick}`}
              cx={xFor(point)}
              cy={yFor(point.price)}
              r="3"
              className={point.boardState === "sealedLimitUp" ? "event-dot up" : "event-dot down"}
            />
          ) : null
        )}
        {showTradeMarks
          ? tradeMarks.map((mark) => {
              const x = xForTick(mark.tick);
              const y = yFor(mark.price);
              const textY = mark.side === "buy" ? y - 7 : y + 12;
              return (
                <g className={`trade-mark ${mark.side}`} key={`${mark.side}-${mark.day}-${mark.tick}-${mark.count}`}>
                  <title>
                    {`${mark.side.toUpperCase()} ${shortShares(mark.shares)} @ ${mark.price.toFixed(2)} | ${shortMoney(mark.notional)}${
                      mark.count > 1 ? ` | ${mark.count} fills` : ""
                    }`}
                  </title>
                  <circle cx={x} cy={y} r="3.2" />
                  <text x={x + 5} y={textY}>{mark.side === "buy" ? "B" : "S"}</text>
                </g>
              );
            })
          : null}
        {last ? (
          <>
            <circle cx={xFor(last)} cy={yFor(last.price)} r="3.5" className="last-dot" />
            <text x={Math.min(width - 4, xFor(last) + 34)} y={Math.max(12, yFor(last.price) - 7)} className="price-tag" textAnchor="end">{last.price.toFixed(2)}</text>
          </>
        ) : null}
        {hover ? (
          <g className="chart-hover-layer">
            <line x1={xForTick(hover.tick)} x2={xForTick(hover.tick)} y1="0" y2={height} />
            <line x1="0" x2={width} y1={hover.y} y2={hover.y} />
            <circle cx={xFor(hover.point)} cy={yFor(hover.point.price)} r="3.4" />
            <rect x="4" y="4" width="122" height="34" rx="4" />
            <text x="10" y="17">{formatIntradayTime(hover.point.tick)} {hover.point.kind === "auctionIndicative" ? "ref" : "price"} {hover.point.price.toFixed(2)}</text>
            <text x="10" y="31">{signedPct(((hover.point.price - previousClose) / previousClose) * 100)}</text>
            <text x={width} y={Math.min(height - 20, Math.max(12, hover.y - 5))} textAnchor="end">
              cursor {hover.coordPrice.toFixed(2)}
            </text>
          </g>
        ) : null}
        <g className="axis-labels">
          <text x="0" y={height - 2}>09:30</text>
          <text x={xForTick(120)} y={height - 2} textAnchor="middle">11:30</text>
          <text x={xForTick(150)} y={height - 2} textAnchor="middle">13:00</text>
          <text x={width} y={height - 2} textAnchor="end">15:00</text>
        </g>
        <g className="axis-labels price-axis">
          <text x={width} y="10" textAnchor="end">{high.toFixed(2)}</text>
          <text x={width} y={Math.max(20, baseline - 4)} textAnchor="end">prev {previousClose.toFixed(2)}</text>
          <text x={width} y={height - 16} textAnchor="end">{low.toFixed(2)}</text>
        </g>
      </svg>
      <button
        className={showTradeMarks ? "trade-mark-toggle active" : "trade-mark-toggle"}
        type="button"
        onClick={onToggleTradeMarks}
        aria-pressed={showTradeMarks}
        aria-label="Toggle buy and sell marks"
      >
        <span />
        B/S
      </button>
    </div>
  );
}

function KLineChart({
  candles,
  range,
  axisMode,
  currentDay,
  tradeMarks,
  showTradeMarks
}: {
  candles: DailyCandle[];
  range: KLineRange;
  axisMode: KLineAxisMode;
  currentDay: number;
  tradeMarks: DailyTradeMark[];
  showTradeMarks: boolean;
}) {
  const [hover, setHover] = useState<KLineHover | undefined>();
  const liveCandles = candles.filter((candle) => candle.day <= currentDay);
  const rangeSize = range === "all" ? liveCandles.length : range;
  const visibleCandles = liveCandles.slice(-rangeSize);
  const prices = visibleCandles.flatMap((candle) => [candle.high, candle.low]);
  if (visibleCandles.length === 0 || prices.length === 0) {
    return (
      <div className="intraday-frame">
        <svg className="chart-svg" viewBox="0 0 360 172" role="img" aria-label="K-line candlestick chart" />
      </div>
    );
  }
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(0.01, max - min);
  const lastClose = visibleCandles.at(-1)?.close ?? max;
  const axisPct = axisMode === "pct10" ? 0.1 : axisMode === "pct20" ? 0.2 : undefined;
  const low = axisPct === undefined ? min - span * 0.18 : Math.min(min, lastClose * (1 - axisPct));
  const high = axisPct === undefined ? max + span * 0.18 : Math.max(max, lastClose * (1 + axisPct));
  const width = 360;
  const height = 172;
  const priceHeight = 132;
  const volumeTop = 138;
  const slotCount = Math.max(5, visibleCandles.length);
  const candleWidth = Math.max(4, Math.min(13, width / slotCount - 5));
  const xFor = (index: number) => (visibleCandles.length <= 1 ? 14 : 10 + (index / Math.max(1, visibleCandles.length - 1)) * (width - 20));
  const yFor = (price: number) => priceHeight - ((price - low) / (high - low)) * priceHeight;
  const priceForY = (y: number) => high - (Math.min(priceHeight, Math.max(0, y)) / priceHeight) * (high - low);
  const maxVolume = Math.max(1, ...visibleCandles.map((candle) => candle.volume));
  const volumeY = (volume: number) => volumeTop + 28 - (volume / maxVolume) * 28;
  const ma = visibleCandles.map((_, index) => {
    const slice = visibleCandles.slice(Math.max(0, index - 4), index + 1);
    return slice.reduce((sum, candle) => sum + candle.close, 0) / slice.length;
  });
  const ma10 = visibleCandles.map((_, index) => {
    const slice = visibleCandles.slice(Math.max(0, index - 9), index + 1);
    return slice.reduce((sum, candle) => sum + candle.close, 0) / slice.length;
  });
  const maPath = ma.map((price, index) => `${xFor(index).toFixed(1)},${yFor(price).toFixed(1)}`).join(" ");
  const ma10Path = ma10.map((price, index) => `${xFor(index).toFixed(1)},${yFor(price).toFixed(1)}`).join(" ");
  const visibleDaySet = new Set(visibleCandles.map((candle) => candle.day));
  const visibleTradeMarks = tradeMarks.filter((mark) => visibleDaySet.has(mark.day));
  const candleIndexByDay = new Map(visibleCandles.map((candle, index) => [candle.day, index]));
  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(width, Math.max(0, ((event.clientX - rect.left) / rect.width) * width));
    const y = Math.min(height, Math.max(0, ((event.clientY - rect.top) / rect.height) * height));
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    visibleCandles.forEach((_, index) => {
      const distance = Math.abs(xFor(index) - x);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    setHover({
      x,
      y,
      coordPrice: priceForY(y),
      candle: visibleCandles[nearestIndex],
      index: nearestIndex
    });
  };

  return (
    <div className="intraday-frame">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="K-line candlestick chart"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(undefined)}
      >
        <GridLines width={width} height={height} xLines={[0.25, 0.5, 0.75]} />
        {visibleCandles.map((candle, index) => {
          const up = candle.close >= candle.open;
          const x = xFor(index);
          const openY = yFor(candle.open);
          const closeY = yFor(candle.close);
          const bodyY = Math.min(openY, closeY);
          const bodyHeight = Math.max(2, Math.abs(openY - closeY));
          return (
            <g key={`${candle.day}-${index}`} className={up ? "candle up" : "candle down"}>
              <line x1={x} x2={x} y1={yFor(candle.high)} y2={yFor(candle.low)} />
              <rect x={x - candleWidth / 2} y={bodyY} width={candleWidth} height={bodyHeight} rx="1" />
              <rect className="volume-bar" x={x - candleWidth / 2} y={volumeY(candle.volume)} width={candleWidth} height={volumeTop + 28 - volumeY(candle.volume)} rx="1" />
            </g>
          );
        })}
        <polyline points={maPath} className="ma-line" />
        <polyline points={ma10Path} className="ma-line secondary" />
        {showTradeMarks
          ? visibleTradeMarks.map((mark) => {
              const index = candleIndexByDay.get(mark.day);
              if (index === undefined) return null;
              const x = xFor(index);
              const y = yFor(mark.price);
              const textY = mark.side === "buy" ? y - 7 : y + 12;
              return (
                <g className={`trade-mark kline-trade-mark ${mark.side}`} key={`${mark.side}-${mark.day}`}>
                  <title>
                    {`${mark.side.toUpperCase()} ${formatDayLabel(mark.day)} ${shortShares(mark.shares)} @ ${mark.price.toFixed(2)} | ${shortMoney(mark.notional)}${
                      mark.count > 1 ? ` | ${mark.count} fills` : ""
                    }`}
                  </title>
                  <circle cx={x} cy={y} r="3.2" />
                  <text x={x + 5} y={textY}>{mark.side === "buy" ? "B" : "S"}</text>
                </g>
              );
            })
          : null}
        {hover ? (
          <g className="chart-hover-layer kline-hover-layer">
            <line x1={xFor(hover.index)} x2={xFor(hover.index)} y1="0" y2={height} />
            <line x1="0" x2={width} y1={Math.min(priceHeight, hover.y)} y2={Math.min(priceHeight, hover.y)} />
            <circle cx={xFor(hover.index)} cy={yFor(hover.candle.close)} r="3.4" />
            <rect x="4" y="4" width="154" height="50" rx="4" />
            <text x="10" y="17">{formatDayLabel(hover.candle.day)} O {hover.candle.open.toFixed(2)} H {hover.candle.high.toFixed(2)}</text>
            <text x="10" y="31">L {hover.candle.low.toFixed(2)} C {hover.candle.close.toFixed(2)} {signedPct(((hover.candle.close - hover.candle.open) / Math.max(0.01, hover.candle.open)) * 100)}</text>
            <text x="10" y="45">Vol {shortShares(hover.candle.volume)}</text>
            <text x={width} y={Math.min(priceHeight - 4, Math.max(12, hover.y - 5))} textAnchor="end">
              cursor {hover.coordPrice.toFixed(2)}
            </text>
          </g>
        ) : null}
        <g className="ma-legend">
          <text x="0" y="11">MA5</text>
          <text x="31" y="11" className="secondary">MA10</text>
        </g>
        <g className="axis-labels">
          <text x="0" y={height - 2}>{formatDayLabel(visibleCandles[0].day)}</text>
          <text x={width} y={height - 2} textAnchor="end">{formatDayLabel(visibleCandles.at(-1)?.day ?? 1)}</text>
        </g>
        <g className="axis-labels price-axis">
          <text x={width} y="10" textAnchor="end">{high.toFixed(2)}</text>
          <text x={width} y={priceHeight - 3} textAnchor="end">{low.toFixed(2)}</text>
        </g>
      </svg>
    </div>
  );
}

function GridLines({ width, height, xLines = [0.25, 0.5, 0.75] }: { width: number; height: number; xLines?: number[] }) {
  return (
    <g className="grid-lines">
      {[0.25, 0.5, 0.75].map((line) => (
        <line key={`h-${line}`} x1="0" x2={width} y1={height * line} y2={height * line} />
      ))}
      {xLines.map((line) => (
        <line key={`v-${line}`} y1="0" y2={height} x1={width * line} x2={width * line} />
      ))}
    </g>
  );
}

function CostDistributionCard({ stock }: { stock: Stock }) {
  const rows = [
    ["> +10%", stock.costDistribution.deepProfit, "up"],
    ["0% to +10%", stock.costDistribution.profit, "up-soft"],
    ["-10% to 0%", stock.costDistribution.nearCost, "down-soft"],
    ["< -10%", stock.costDistribution.loss + stock.costDistribution.deepLoss, "down"]
  ] as const;

  return (
    <div className="data-card cost-card">
      <h3>Holder Cost Distribution</h3>
      {rows.map(([label, value, tone]) => (
        <div className="cost-row" key={label}>
          <span>{label}</span>
          <div className="cost-track">
            <div className={`cost-fill ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
          </div>
          <strong>{value.toFixed(1)}%</strong>
        </div>
      ))}
    </div>
  );
}

function DataCard({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="data-card">
      <h3>{title}</h3>
      {rows.map(([label, value]) => (
        <div className="data-row" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function PanelTitle({ title, icon }: { title: string; icon?: ReactNode }) {
  return (
    <div className="panel-title">
      <div>{icon}{title}</div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "heat" }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone ? `tone-${tone}` : ""}>{value}</strong>
    </div>
  );
}

function InfoCell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "heat" }) {
  return (
    <div className="info-cell">
      <span>{label}</span>
      <strong className={tone ? `tone-${tone}` : ""}>{value}</strong>
    </div>
  );
}

function Signal({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="signal">
      <span>{label}</span>
      <strong className={tone ? `tone-${tone}` : ""}>{value}</strong>
    </div>
  );
}

function ProgressBar({ value, dayValue, tick }: { value: number; dayValue?: number; tick?: number }) {
  const auctionValue = tick === undefined ? 0 : Math.max(0, Math.min(1, tick / Math.max(1, CONTINUOUS_START_TICK)));
  return (
    <div className="progress">
      <div className="run-progress-track">
        <div className="run-progress-fill" style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
      </div>
      {tick === undefined ? null : (
        <div className="auction-progress-track" aria-hidden="true">
          <div className="auction-progress-fill" style={{ width: `${Math.max(2, Math.min(100, auctionValue * 100))}%` }} />
          <span className="auction-marker cancelable" />
          <span className="auction-marker locked" />
          <span className="auction-marker match" />
        </div>
      )}
      {dayValue === undefined ? null : (
        <div className="day-progress-track" aria-hidden="true">
          <div className="day-progress-fill" style={{ width: `${Math.max(2, Math.min(100, dayValue * 100))}%` }} />
          <span className="midday-marker" />
        </div>
      )}
    </div>
  );
}

function calculateWeightedMarketValue(game: GameState): number {
  return Object.values(game.stocks)
    .filter((stock) => stock.assetType === "stock")
    .reduce((total, stock) => total + stock.sharesOutstanding * stock.price, 0);
}

function calculatePreviousCloseWeightedMarketValue(game: GameState): number {
  return Object.values(game.stocks)
    .filter((stock) => stock.assetType === "stock")
    .reduce((total, stock) => total + stock.sharesOutstanding * stock.previousClose, 0);
}

function calculateWhaleIndex(game: GameState, baseValue: number): WhaleIndexSnapshot {
  const currentValue = calculateWeightedMarketValue(game);
  const previousCloseValue = calculatePreviousCloseWeightedMarketValue(game);
  const value = baseValue > 0 ? (currentValue / baseValue) * 1000 : 1000;
  const previousCloseIndex = baseValue > 0 ? (previousCloseValue / baseValue) * 1000 : 1000;
  const change = value - previousCloseIndex;
  const changePct = previousCloseValue > 0 ? (currentValue / previousCloseValue - 1) * 100 : 0;
  return {
    value,
    change,
    changePct,
    tone: marketTone(change)
  };
}

function marketTone(value: number): MarketTone {
  if (value > 0.005) return "up";
  if (value < -0.005) return "down";
  return "flat";
}

function createTradeMarks(results: TickResult[], stockId: StockId, currentDay: number): TradeMark[] {
  const fills = [...results]
    .reverse()
    .flatMap((result) =>
      result.playerFills
        .filter((fill) => fill.stockId === stockId && fill.filledShares > 0)
        .map((fill) => ({
          side: fill.side,
          day: result.day,
          tick: result.tick,
          price: fill.avgPrice > 0 ? fill.avgPrice : fill.finalPrice,
          shares: fill.filledShares,
          notional: fill.filledNotional
        }))
    )
    .filter((fill) => fill.day === currentDay)
    .sort((a, b) => a.tick - b.tick);
  const marks: TradeMark[] = [];

  for (const fill of fills) {
    const last = marks.at(-1);
    if (last && last.side === fill.side && fill.tick - last.tick <= 8) {
      const totalNotional = last.notional + fill.notional;
      const totalShares = last.shares + fill.shares;
      last.tick = fill.tick;
      last.shares = totalShares;
      last.notional = totalNotional;
      last.price = totalShares > 0 ? totalNotional / totalShares : fill.price;
      last.count += 1;
    } else {
      marks.push({
        ...fill,
        count: 1
      });
    }
  }

  return marks;
}

function createDailyTradeMarks(fillHistory: PlayerFillRecord[], stockId: StockId): DailyTradeMark[] {
  const grouped = new Map<string, DailyTradeMark>();

  for (const record of fillHistory) {
    const fill = record.fill;
    if (fill.stockId !== stockId || fill.filledShares <= 0 || fill.filledNotional <= 0) continue;
    const key = `${record.day}-${fill.side}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        side: fill.side,
        day: record.day,
        price: fill.avgPrice > 0 ? fill.avgPrice : fill.finalPrice,
        shares: fill.filledShares,
        notional: fill.filledNotional,
        count: 1
      });
      continue;
    }

    const shares = existing.shares + fill.filledShares;
    const notional = existing.notional + fill.filledNotional;
    grouped.set(key, {
      ...existing,
      price: notional / Math.max(1, shares),
      shares,
      notional,
      count: existing.count + 1
    });
  }

  return Array.from(grouped.values()).sort((first, second) => first.day - second.day || first.side.localeCompare(second.side));
}

function getTriggeredConditionalOrders(game: GameState, orders: ConditionalOrder[]): ConditionalOrder[] {
  if ((game.phase !== "intraday" && game.phase !== "closingAuction") || game.tick < CONTINUOUS_START_TICK) return [];

  return orders.filter((order) => {
    const stock = game.stocks[order.stockId];
    if (!stock) return false;
    if (order.condition.type === "day") return game.day >= order.condition.targetDay;
    if (order.condition.type === "tick") return game.tick >= order.condition.targetTick;
    return order.condition.operator === "above"
      ? stock.price >= order.condition.triggerPrice
      : stock.price <= order.condition.triggerPrice;
  });
}

function conditionalOrderToAction(order: ConditionalOrder): PlayerAction {
  return order.side === "buy"
    ? {
        type: "marketBuy",
        stockId: order.stockId,
        amountCash: roundMoney(order.shares * order.limitPrice),
        limitPrice: order.limitPrice
      }
    : {
        type: "marketSell",
        stockId: order.stockId,
        shares: order.shares,
        limitPrice: order.limitPrice
      };
}

function conditionalOrderToIntent(order: ConditionalOrder, submittedDay: number, submittedTick: number): OrderIntent {
  return {
    id: order.id,
    source: "conditional",
    side: order.side,
    stockId: order.stockId,
    shares: order.shares,
    limitPrice: order.limitPrice,
    submittedDay,
    submittedTick
  };
}

function reconcileConditionalOrdersAfterTick(
  current: ConditionalOrder[],
  triggered: ConditionalOrder[],
  result: TickResult
): ConditionalOrder[] {
  const triggeredById = new Map(triggered.map((order) => [order.id, order]));
  if (triggeredById.size === 0 && !current.some((order) => order.working)) return current;

  const filledShares = new Map<string, number>();
  for (const fill of result.playerFills) {
    if (fill.filledShares <= 0) continue;
    const key = `${fill.stockId}-${fill.side}`;
    filledShares.set(key, (filledShares.get(key) ?? 0) + fill.filledShares);
  }

  return current.flatMap((order) => {
    const triggeredOrder = triggeredById.get(order.id);
    const shouldReconcile = Boolean(triggeredOrder || order.working);
    if (!shouldReconcile) return [order];

    const key = `${order.stockId}-${order.side}`;
    const availableFill = filledShares.get(key) ?? 0;
    const consumed = Math.min(order.shares, availableFill);
    filledShares.set(key, Math.max(0, availableFill - consumed));
    const remainingShares = Math.max(0, order.shares - consumed);
    return remainingShares > 0 ? [{ ...order, shares: remainingShares, working: true }] : [];
  });
}

function createOrderToasts(result: TickResult, intents: OrderIntent[], game: GameState): Array<Omit<OrderToast, "id">> {
  const toasts: Array<Omit<OrderToast, "id">> = [];
  const fillGroups = new Map<string, { side: TradeSide; stockId: StockId; shares: number; notional: number }>();

  for (const fill of result.playerFills) {
    if (fill.filledShares <= 0 || fill.filledNotional <= 0) continue;
    const key = `${fill.stockId}-${fill.side}`;
    const existing = fillGroups.get(key);
    if (existing) {
      existing.shares += fill.filledShares;
      existing.notional += fill.filledNotional;
    } else {
      fillGroups.set(key, {
        side: fill.side,
        stockId: fill.stockId,
        shares: fill.filledShares,
        notional: fill.filledNotional
      });
    }
  }

  for (const group of fillGroups.values()) {
    const price = group.notional / Math.max(1, group.shares);
    toasts.push({
      kind: "success",
      side: group.side,
      stockId: group.stockId,
      shares: group.shares,
      price,
      day: result.day,
      tick: result.tick,
      message: `${tradeSideLabel(group.side)}成功（${formatToastShares(group.shares)}股，${price.toFixed(2)}，${group.stockId}，${result.tick}tick）`
    });
  }

  for (const intent of intents) {
    if (intent.source === "cancel") continue;
    const filled = result.playerFills.some((fill) => fill.stockId === intent.stockId && fill.side === intent.side && fill.filledShares > 0);
    if (filled) continue;
    if (intent.side === "buy" && hasRestingBuyFromIntent(game, intent, result)) continue;

    toasts.push({
      kind: "failure",
      side: intent.side,
      stockId: intent.stockId,
      shares: intent.shares,
      price: intent.limitPrice,
      day: result.day,
      tick: result.tick,
      message: `${tradeSideLabel(intent.side)}失败（${formatToastShares(intent.shares)}股，${intent.limitPrice.toFixed(2)}，${intent.stockId}，${result.tick}tick）`
    });
  }

  for (const event of result.events) {
    if (event.type !== "playerOrderExpired" || !event.stockId) continue;
    const stock = game.stocks[event.stockId];
    toasts.push({
      kind: "failure",
      side: "buy",
      stockId: event.stockId,
      shares: 0,
      price: stock?.price ?? 0,
      day: result.day,
      tick: result.tick,
      message: `买入失败（挂单过期，${event.stockId}，${result.tick}tick）`
    });
  }

  return toasts;
}

function hasRestingBuyFromIntent(game: GameState, intent: OrderIntent, result: TickResult): boolean {
  return game.player.activeOrders.some(
    (order) =>
      order.owner === "player" &&
      order.side === "buy" &&
      order.stockId === intent.stockId &&
      order.createdDay === result.day &&
      order.createdTick === result.tick
  );
}

function tradeSideLabel(side: TradeSide): string {
  return side === "buy" ? "买入" : "卖出";
}

function formatToastShares(value: number): string {
  return Math.floor(value).toLocaleString();
}

function formatCondition(condition: ConditionSpec): string {
  if (condition.type === "day") return `Day >= ${condition.targetDay}`;
  if (condition.type === "tick") return `Tick >= ${condition.targetTick}`;
  return `${condition.operator === "above" ? "Price >=" : "Price <="} ${condition.triggerPrice.toFixed(2)}`;
}

function findNearestTickPoint(points: TickPrice[], tick: number): TickPrice {
  return points.reduce((nearest, point) => (Math.abs(point.tick - tick) < Math.abs(nearest.tick - tick) ? point : nearest), points[0]);
}

function formatIntradayTime(tick: number): string {
  if (tick <= 5) return `Pre ${tick}`;
  if (tick <= 15) return `Auc-C ${tick}`;
  if (tick <= 24) return `Auc-L ${tick}`;
  if (tick === 25) return "Open";
  if (tick <= 30) return `Break ${tick}`;
  const clampedTick = Math.max(0, Math.min(GAME_CONFIG.ticksPerDay, tick));
  const minutes = clampedTick <= 120 ? clampedTick : clampedTick <= 150 ? 120 : clampedTick - 30;
  const totalMinutes = 9 * 60 + 30 + minutes;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function createInitialUiGame(seed: string) {
  const game = createInitialGame(seed);
  return game;
}

function readAutosave(): AutosaveFile | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    const raw = window.localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return undefined;

    const parsed = JSON.parse(raw) as Partial<AutosaveFile>;
    if (parsed.version !== 1 || !parsed.game || !parsed.ui) return undefined;
    if (!isAutosaveCompatible(parsed as AutosaveFile)) {
      clearAutosave();
      return undefined;
    }
    return parsed as AutosaveFile;
  } catch {
    return undefined;
  }
}

function isAutosaveCompatible(save: AutosaveFile): boolean {
  if (!save.game?.stocks || !save.game.stocks.DRAGON_SOFT) return false;
  if (!stockIds.every((stockId) => Boolean(save.game.stocks[stockId]))) return false;
  if (save.ui.selectedStockId && !save.game.stocks[save.ui.selectedStockId]) return false;
  return true;
}

function writeAutosave(args: {
  game: GameState;
  selectedStockId: StockId;
  tickIntervalSeconds: number;
  kLineRange: KLineRange;
  kLineAxisMode: KLineAxisMode;
  navPage: NavPage;
  showTradeMarks: boolean;
  simpleMarketMode: boolean;
  indexBaseValue: number;
  playerFillHistory: PlayerFillRecord[];
  conditionalOrders: ConditionalOrder[];
}): boolean {
  if (typeof window === "undefined") return false;

  const save: AutosaveFile = {
    version: 1,
    savedAt: new Date().toISOString(),
    game: args.game,
    ui: {
      selectedStockId: args.selectedStockId,
      tickIntervalSeconds: args.tickIntervalSeconds,
      kLineRange: args.kLineRange,
      kLineAxisMode: args.kLineAxisMode,
      navPage: args.navPage,
      showTradeMarks: args.showTradeMarks,
      simpleMarketMode: args.simpleMarketMode,
      indexBaseValue: args.indexBaseValue,
      playerFillHistory: args.playerFillHistory,
      conditionalOrders: args.conditionalOrders
    }
  };

  try {
    window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    // Autosave is best-effort; gameplay should continue if storage is full or blocked.
    return false;
  }
}

function clearAutosave(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Ignore storage failures while resetting a local run.
  }
}

function getInitialStockId(save: AutosaveFile | undefined, game: GameState): StockId {
  const savedStockId = save?.ui.selectedStockId;
  return savedStockId && game.stocks[savedStockId] ? savedStockId : "DRAGON_SOFT";
}

function formatSaveTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function money(value: number) {
  return `CNY ${Math.round(value).toLocaleString()}`;
}

function shortMoney(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `CNY ${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `CNY ${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `CNY ${(value / 1_000).toFixed(1)}K`;
  return `CNY ${value.toFixed(0)}`;
}

function compactMoney(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function signedMoney(value: number) {
  return `${value >= 0 ? "+" : ""}${money(value)}`;
}

function signedPriceMove(value: number) {
  return `${value >= 0 ? "+" : ""}CNY ${value.toFixed(2)}`;
}

function signedShortMoney(value: number) {
  return `${value >= 0 ? "+" : ""}${shortMoney(value)}`;
}

function shortShares(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.floor(value).toLocaleString();
}

function signedPct(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatEtfPremium(stock: Stock): string {
  return signedPct((stock.etf?.premiumDiscount ?? 0) * 100);
}

function formatDayLabel(day: number) {
  return day < 1 ? `D${day}` : `D${day}`;
}

function dailyChangePct(stock: Stock) {
  return ((stock.price - stock.previousClose) / stock.previousClose) * 100;
}

function sectorLabel(value: string) {
  return titleCase(value);
}

function boardLabel(value: string) {
  if (value === "growth") return "SZ Growth";
  if (value === "main") return "Main";
  return value.toUpperCase();
}

function boardShortLabel(value: string) {
  if (value === "growth") return "Growth";
  if (value === "main") return "Main";
  return value.toUpperCase();
}

function boardStateLabel(value: BoardState) {
  return value.replace(/[A-Z]/g, (letter) => ` ${letter}`).replace(/^./, (letter) => letter.toUpperCase());
}

function stateClass(value: BoardState) {
  if (value === "sealedLimitUp" || value === "attackingLimitUp") return "hot";
  if (value === "panic" || value === "limitDown" || value === "brokenBoard") return "cold";
  if (value === "weakSeal") return "watch";
  return "normal";
}

function spread(depth: ReturnType<typeof createMarketDepth>) {
  const ask = depth.askLevels[0]?.price ?? 0;
  const bid = depth.bidLevels[0]?.price ?? 0;
  return Math.max(0, ask - bid);
}

function liquidityRisk(stock: Stock) {
  const depth = calculateEffectiveDepth(stock);
  const ratio = stock.marketCap > 0 ? depth / stock.marketCap : 0;
  if (ratio < 0.0002) return "High";
  if (ratio < 0.0006) return "Medium";
  return "Low";
}

function quantHint(quantPresence: number, trace?: StockTraceView) {
  const sell = trace?.pressure.quantSellPressure ?? 0;
  const buy = trace?.pressure.quantBuyPressure ?? 0;
  if (sell > buy * 1.4 && sell > 0) return "Algo selling";
  if (buy > sell * 1.4 && buy > 0) return "Fast bid";
  if (quantPresence > 65) return "Fast money";
  return "Quiet";
}

function titleCase(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
