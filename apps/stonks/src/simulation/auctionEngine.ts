import { clamp, roundMoney, roundShares } from "../game/config";
import { syncDailyCandle } from "../game/charting";
import { createRng } from "../game/rng";
import type { AuctionOrder, AuctionPhase, ExecutionFill, GameState, PlayerAction, Stock, StockId, Whale, WhaleIntention } from "../game/types";
import { recordBuyFill, recordSellFill, recalculatePlayerNetWorth } from "../player/portfolio";
import { getLowerLimit, getUpperLimit, roundPrice } from "./boardEngine";
import { markWhaleToMarket, recordWhaleBuy, recordWhaleSell } from "./whaleAccounting";

export const AUCTION_PREOPEN_END = 5;
export const AUCTION_CANCELABLE_START = 6;
export const AUCTION_CANCELABLE_END = 15;
export const AUCTION_LOCKED_START = 16;
export const AUCTION_LOCKED_END = 24;
export const AUCTION_MATCH_TICK = 25;
export const AUCTION_BREAK_END = 30;
export const CONTINUOUS_START_TICK = 31;

export type AuctionMatchResult = {
  price: number;
  matchedShares: number;
  buyRemainingShares: number;
  sellRemainingShares: number;
};

type AuctionTickTrace = {
  stock: Stock;
  playerFills: ExecutionFill[];
  whaleFills: ExecutionFill[];
};

export function getAuctionPhaseForTick(tick: number): AuctionPhase {
  if (tick <= AUCTION_PREOPEN_END) return "preOpen";
  if (tick <= AUCTION_CANCELABLE_END) return "cancelable";
  if (tick <= AUCTION_LOCKED_END) return "locked";
  if (tick === AUCTION_MATCH_TICK) return "match";
  if (tick <= AUCTION_BREAK_END) return "break";
  return "continuous";
}

export function canSubmitAuctionOrder(tick: number): boolean {
  const phase = getAuctionPhaseForTick(tick);
  return phase === "cancelable" || phase === "locked";
}

export function canCancelAuctionOrder(tick: number): boolean {
  return getAuctionPhaseForTick(tick) === "cancelable";
}

export function processAuctionTick(game: GameState, actions: PlayerAction[]): { traces: AuctionTickTrace[]; playerFills: ExecutionFill[]; whaleFills: ExecutionFill[] } {
  const phase = getAuctionPhaseForTick(game.tick);
  const traces: AuctionTickTrace[] = [];
  const playerFills: ExecutionFill[] = [];
  const whaleFills: ExecutionFill[] = [];

  if (phase === "preOpen" || phase === "break") {
    for (const stock of Object.values(game.stocks)) {
      updateAuctionReference(stock);
      pushAuctionPrint(game, stock, phase === "break" ? "auctionOpen" : "auctionIndicative");
    }
    return { traces, playerFills, whaleFills };
  }

  for (const action of actions) {
    if (action.type === "cancelAuctionOrder") cancelPlayerAuctionOrder(game, action.orderId);
  }

  if (phase === "cancelable" || phase === "locked") {
    for (const stock of Object.values(game.stocks)) {
      stock.auction.phase = phase;
      expireUnusableAuctionOrders(stock);
      cancelNpcAuctionOrders(game, stock);
      submitPlayerAuctionOrders(game, stock, actions, phase);
      createNpcAuctionOrders(game, stock, phase);
      updateAuctionReference(stock);
      pushAuctionPrint(game, stock, "auctionIndicative");
      traces.push({ stock, playerFills: [], whaleFills: [] });
    }
    recalculatePlayerNetWorth(game);
    return { traces, playerFills, whaleFills };
  }

  if (phase === "match") {
    for (const stock of Object.values(game.stocks)) {
      stock.auction.phase = "match";
      updateAuctionReference(stock);
      const fills = matchStockAuction(game, stock);
      playerFills.push(...fills.playerFills);
      whaleFills.push(...fills.whaleFills);
      pushAuctionPrint(game, stock, "auctionOpen");
      syncDailyCandle(stock, game.day);
      traces.push({ stock, playerFills: fills.playerFills, whaleFills: fills.whaleFills });
    }
    recalculatePlayerNetWorth(game);
  }

  return { traces, playerFills, whaleFills };
}

export function determineAuctionPrice(stock: Stock, orders: AuctionOrder[]): AuctionMatchResult {
  const openOrders = orders.filter((order) => order.status === "open" && order.remainingShares > 0);
  const lowerLimit = getLowerLimit(stock);
  const upperLimit = getUpperLimit(stock);
  const candidates = Array.from(new Set([...openOrders.map((order) => roundPrice(order.price)), stock.previousClose, lowerLimit, upperLimit]))
    .filter((price) => price >= lowerLimit && price <= upperLimit)
    .sort((a, b) => a - b);

  let best: AuctionMatchResult | undefined;
  let bestUnmatched = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const price of candidates) {
    const buyShares = openOrders
      .filter((order) => order.side === "buy" && order.price >= price)
      .reduce((total, order) => total + order.remainingShares, 0);
    const sellShares = openOrders
      .filter((order) => order.side === "sell" && order.price <= price)
      .reduce((total, order) => total + order.remainingShares, 0);
    const matchedShares = Math.min(buyShares, sellShares);
    const unmatched = Math.abs(buyShares - sellShares);
    const distance = Math.abs(price - stock.previousClose);

    if (
      !best ||
      matchedShares > best.matchedShares ||
      (matchedShares === best.matchedShares && unmatched < bestUnmatched) ||
      (matchedShares === best.matchedShares && unmatched === bestUnmatched && distance < bestDistance)
    ) {
      best = {
        price,
        matchedShares,
        buyRemainingShares: Math.max(0, buyShares - matchedShares),
        sellRemainingShares: Math.max(0, sellShares - matchedShares)
      };
      bestUnmatched = unmatched;
      bestDistance = distance;
    }
  }

  return best ?? {
    price: stock.previousClose,
    matchedShares: 0,
    buyRemainingShares: 0,
    sellRemainingShares: 0
  };
}

export function resetAuctionState(stock: Stock): void {
  stock.auction = {
    phase: "preOpen",
    bias: {
      randomGap: 0,
      closeMovePct: 0,
      overrunFatigue: 0,
      richFatigue: 0,
      boardCarry: 0,
      repeatedLimitRelief: 0,
      washoutAttention: 0,
      openingDemandBias: 0
    },
    orders: [],
    referencePrice: stock.previousClose,
    referenceMatchedShares: 0,
    referenceMatchedNotional: 0,
    buyRemainingShares: 0,
    sellRemainingShares: 0,
    imbalanceShares: 0,
    settled: false
  };
}

function submitPlayerAuctionOrders(game: GameState, stock: Stock, actions: PlayerAction[], phase: AuctionPhase): void {
  for (const action of actions) {
    if (action.type !== "marketBuy" && action.type !== "marketSell") continue;
    if (action.stockId !== stock.id) continue;

    const limitPrice = clamp(roundPrice(action.limitPrice ?? stock.price), getLowerLimit(stock), getUpperLimit(stock));
    if (action.type === "marketBuy") {
      const reservedCash = roundMoney(Math.min(game.player.cash, Math.max(0, action.amountCash)));
      const shares = roundShares(reservedCash / Math.max(0.01, limitPrice));
      if (reservedCash <= 0 || shares <= 0) continue;
      game.player.cash = roundMoney(game.player.cash - reservedCash);
      stock.auction.orders.push({
        id: `A-P-${game.day}-${game.tick}-${stock.id}-${stock.auction.orders.length}`,
        owner: "player",
        stockId: stock.id,
        side: "buy",
        price: limitPrice,
        shares,
        remainingShares: shares,
        frozenCash: reservedCash,
        cancellable: phase === "cancelable",
        submittedDay: game.day,
        submittedTick: game.tick,
        status: "open"
      });
      appendAuctionEvent(game, stock, `Player submitted auction buy ${shares.toLocaleString()} ${stock.name} @ ${limitPrice.toFixed(2)}.`);
    } else {
      const sellable = Math.max(0, (game.player.positions[stock.id]?.sellableShares ?? 0) - getReservedAuctionSellShares(stock));
      const shares = Math.min(roundShares(action.shares), sellable);
      if (shares <= 0) continue;
      stock.auction.orders.push({
        id: `A-P-${game.day}-${game.tick}-${stock.id}-${stock.auction.orders.length}`,
        owner: "player",
        stockId: stock.id,
        side: "sell",
        price: limitPrice,
        shares,
        remainingShares: shares,
        frozenShares: shares,
        cancellable: phase === "cancelable",
        submittedDay: game.day,
        submittedTick: game.tick,
        status: "open"
      });
      appendAuctionEvent(game, stock, `Player submitted auction sell ${shares.toLocaleString()} ${stock.name} @ ${limitPrice.toFixed(2)}.`);
    }
  }
}

function cancelPlayerAuctionOrder(game: GameState, orderId: string): void {
  if (!canCancelAuctionOrder(game.tick)) return;
  for (const stock of Object.values(game.stocks)) {
    const order = stock.auction.orders.find((candidate) => candidate.id === orderId && candidate.owner === "player" && candidate.status === "open");
    if (!order) continue;
    order.status = "cancelled";
    if (order.side === "buy") game.player.cash = roundMoney(game.player.cash + (order.frozenCash ?? 0));
    order.remainingShares = 0;
    appendAuctionEvent(game, stock, `Player cancelled auction order ${orderId}.`);
    return;
  }
}

function createNpcAuctionOrders(game: GameState, stock: Stock, phase: AuctionPhase): void {
  const rng = createRng(`${game.rngSeed}:auction:${game.day}:${game.tick}:${stock.id}`);
  const progress = clamp((game.tick - AUCTION_CANCELABLE_START) / (AUCTION_LOCKED_END - AUCTION_CANCELABLE_START), 0, 1);
  const bias = stock.auction.bias.openingDemandBias;
  const baseNotional = stock.currentLiquidity * (0.1 + progress * 0.18 + stock.attention / 520);
  const positive = Math.max(0, bias);
  const negative = Math.max(0, -bias);
  const dipSupport = stock.retail.dipBuyers / 520 + Math.max(0, stock.retail.fear - 66) / 860 + negative / 110;
  const crowdBuy = baseNotional * (0.28 + stock.retail.greed / 290 + positive / 45 + dipSupport);
  const crowdSell = baseNotional * (0.19 + stock.retail.fear / 340 + negative / 64);
  const institutionLean = (stock.financialHealth - 50) / 100 - Math.max(0, stock.pe - stock.fairPe) / 170;
  const quantLean = stock.momentum / 220 + bias / 35 - stock.heat / 360;

  addSyntheticOrder(game, stock, "retail", "buy", crowdBuy * rng.float(0.55, 1.35), bias, rng);
  addSyntheticOrder(game, stock, "retail", "sell", crowdSell * rng.float(0.55, 1.35), bias, rng);
  addSyntheticOrder(game, stock, "institution", institutionLean >= 0 ? "buy" : "sell", baseNotional * Math.abs(institutionLean) * rng.float(0.4, 1.1), bias, rng);
  addSyntheticOrder(game, stock, "quant", quantLean >= 0 ? "buy" : "sell", baseNotional * Math.abs(quantLean) * (stock.quantPresence / 80) * rng.float(0.25, 0.9), bias, rng);

  for (const whale of game.whales) {
    const whaleOrder = createWhaleAuctionOrder(game, stock, whale, bias, rng);
    if (whaleOrder) stock.auction.orders.push(whaleOrder);
  }

  if (phase === "locked") {
    for (const order of stock.auction.orders) {
      if (order.status === "open") order.cancellable = false;
    }
  }
}

function addSyntheticOrder(
  game: GameState,
  stock: Stock,
  owner: AuctionOrder["owner"],
  side: "buy" | "sell",
  notional: number,
  bias: number,
  rng: ReturnType<typeof createRng>
): void {
  if (notional < 120_000) return;
  const price = sampleAuctionLimitPrice(stock, side, bias, rng);
  const shares = roundShares(notional / Math.max(0.01, price));
  if (shares <= 0) return;
  stock.auction.orders.push({
    id: `A-${owner}-${game.day}-${game.tick}-${stock.id}-${stock.auction.orders.length}`,
    owner,
    stockId: stock.id,
    side,
    price,
    shares,
    remainingShares: shares,
    cancellable: getAuctionPhaseForTick(game.tick) === "cancelable",
    submittedDay: game.day,
    submittedTick: game.tick,
    status: "open"
  });
}

function createWhaleAuctionOrder(
  game: GameState,
  stock: Stock,
  whale: Whale,
  bias: number,
  rng: ReturnType<typeof createRng>
): AuctionOrder | undefined {
  const likes = whale.preferredSectors.includes(stock.sector);
  const position = whale.positions[stock.id] ?? 0;
  const hot = bias > 1.6 || stock.auction.bias.boardCarry > 0.8;
  const cold = bias < -1.6 || stock.auction.bias.boardCarry < -0.8;
  const chance = (likes ? 0.12 : 0.04) + whale.aggression / 1_400 + Math.abs(bias) / 160;
  if (!rng.chance(chance)) return undefined;

  const side: "buy" | "sell" = position > 0 && (cold || stock.heat > whale.heatTolerance || rng.chance(0.35)) ? "sell" : hot || likes ? "buy" : "sell";
  if (side === "buy" && whale.cash < 500_000) return undefined;
  if (side === "sell" && position <= 0) return undefined;

  const price = sampleAuctionLimitPrice(stock, side, bias, rng);
  const notional = side === "buy"
    ? Math.min(whale.cash * rng.float(0.006, 0.026), stock.currentLiquidity * rng.float(0.02, 0.12))
    : Math.min(position * price, stock.currentLiquidity * rng.float(0.025, 0.14));
  const shares = side === "buy" ? roundShares(notional / Math.max(0.01, price)) : Math.min(position, roundShares(notional / Math.max(0.01, price)));
  if (shares <= 0) return undefined;

  return {
    id: `A-W-${game.day}-${game.tick}-${stock.id}-${whale.id}`,
    owner: "whale",
    ownerId: whale.id,
    ownerName: whale.name,
    stockId: stock.id,
    side,
    price,
    shares,
    remainingShares: shares,
    cancellable: getAuctionPhaseForTick(game.tick) === "cancelable",
    submittedDay: game.day,
    submittedTick: game.tick,
    status: "open",
    intention: side === "buy" ? (hot ? "pump" : "accumulate") : cold ? "attack" : "dump"
  };
}

function sampleAuctionLimitPrice(stock: Stock, side: "buy" | "sell", bias: number, rng: ReturnType<typeof createRng>): number {
  const lowerLimit = getLowerLimit(stock);
  const upperLimit = getUpperLimit(stock);
  const limitRatio = (upperLimit - stock.previousClose) / Math.max(0.01, stock.previousClose);
  const oneWordBoard = Math.abs(bias) > 6.5 || Math.abs(stock.auction.bias.boardCarry) > 1.2;
  if (oneWordBoard && bias > 0 && side === "buy" && rng.chance(0.62)) return upperLimit;
  if (oneWordBoard && bias < 0 && side === "sell" && rng.chance(0.62)) return lowerLimit;

  const sideSkew = side === "buy" ? 0.18 : -0.18;
  const targetPct = clamp(bias / 100 + sideSkew * limitRatio + rng.float(-0.18, 0.18) * limitRatio, -limitRatio, limitRatio);
  return roundPrice(clamp(stock.previousClose * (1 + targetPct), lowerLimit, upperLimit));
}

function cancelNpcAuctionOrders(game: GameState, stock: Stock): void {
  if (!canCancelAuctionOrder(game.tick)) return;
  const rng = createRng(`${game.rngSeed}:auction-cancel:${game.day}:${game.tick}:${stock.id}`);
  const panicCancel = stock.auction.bias.openingDemandBias < -3 ? 0.045 : 0;
  for (const order of stock.auction.orders) {
    if (order.owner === "player" || order.status !== "open" || !order.cancellable) continue;
    const age = game.tick - order.submittedTick;
    const chance = clamp(0.13 - age * 0.012 + panicCancel, 0.015, 0.18);
    if (rng.chance(chance)) {
      order.status = "cancelled";
      order.remainingShares = 0;
    }
  }
}

function updateAuctionReference(stock: Stock): void {
  const result = determineAuctionPrice(stock, stock.auction.orders);
  stock.auction.referencePrice = result.price;
  stock.auction.referenceMatchedShares = result.matchedShares;
  stock.auction.referenceMatchedNotional = roundMoney(result.matchedShares * result.price);
  stock.auction.buyRemainingShares = result.buyRemainingShares;
  stock.auction.sellRemainingShares = result.sellRemainingShares;
  stock.auction.imbalanceShares = result.buyRemainingShares - result.sellRemainingShares;
}

function matchStockAuction(game: GameState, stock: Stock): { playerFills: ExecutionFill[]; whaleFills: ExecutionFill[] } {
  const result = determineAuctionPrice(stock, stock.auction.orders);
  const executableBuys = stock.auction.orders.filter((order) => order.status === "open" && order.side === "buy" && order.price >= result.price);
  const executableSells = stock.auction.orders.filter((order) => order.status === "open" && order.side === "sell" && order.price <= result.price);
  let buySharesToFill = result.matchedShares;
  let sellSharesToFill = result.matchedShares;
  const playerFills: ExecutionFill[] = [];
  const whaleFills: ExecutionFill[] = [];

  for (const order of executableBuys) {
    const shares = Math.min(order.remainingShares, buySharesToFill);
    if (shares <= 0) break;
    buySharesToFill -= shares;
    fillAuctionOrder(game, stock, order, shares, result.price, playerFills, whaleFills);
  }

  for (const order of executableSells) {
    const shares = Math.min(order.remainingShares, sellSharesToFill);
    if (shares <= 0) break;
    sellSharesToFill -= shares;
    fillAuctionOrder(game, stock, order, shares, result.price, playerFills, whaleFills);
  }

  for (const order of stock.auction.orders) {
    if (order.owner === "player" && order.side === "buy" && order.status !== "cancelled") {
      const usedCash = (order.shares - order.remainingShares) * result.price;
      const refund = Math.max(0, (order.frozenCash ?? 0) - usedCash);
      game.player.cash = roundMoney(game.player.cash + refund);
      order.frozenCash = roundMoney((order.frozenCash ?? 0) - refund);
    }
    if (order.status !== "open") continue;
    if (order.owner === "player" && order.side === "sell") {
      order.frozenShares = order.remainingShares;
    }
    order.status = order.remainingShares < order.shares ? "partial" : "expired";
  }

  stock.auction.matchedPrice = result.price;
  stock.auction.matchedShares = result.matchedShares;
  stock.auction.matchedNotional = roundMoney(result.matchedShares * result.price);
  stock.auction.settled = true;
  stock.price = result.price;
  stock.open = result.price;
  stock.high = result.price;
  stock.low = result.price;
  stock.volume = result.matchedShares;
  stock.turnover = roundMoney(result.matchedShares * result.price);
  stock.microPrice = result.price;
  stock.momentum = clamp(((result.price - stock.previousClose) / Math.max(0.01, stock.previousClose)) * 1000, -100, 100);
  stock.microstructure.flowMemory = clamp(((result.price / Math.max(0.01, stock.previousClose) - 1) * 100) * 4.8, -28, 28);
  stock.microstructure.shockMemory = clamp(((result.price / Math.max(0.01, stock.previousClose) - 1) * 100) * 8.5, -45, 45);
  stock.microstructure.lastPrintSign = result.price > stock.previousClose ? 1 : result.price < stock.previousClose ? -1 : 0;

  appendAuctionEvent(
    game,
    stock,
    `${stock.name} auction opened at ${result.price.toFixed(2)} with ${result.matchedShares.toLocaleString()} shares matched.`
  );

  return { playerFills, whaleFills };
}

function fillAuctionOrder(
  game: GameState,
  stock: Stock,
  order: AuctionOrder,
  shares: number,
  price: number,
  playerFills: ExecutionFill[],
  whaleFills: ExecutionFill[]
): void {
  const notional = roundMoney(shares * price);
  order.remainingShares -= shares;
  order.status = order.remainingShares <= 0 ? "filled" : "partial";

  const fill: ExecutionFill = {
    owner: order.owner === "whale" ? "whale" : "player",
    ownerId: order.ownerId,
    ownerName: order.ownerName,
    intention: order.intention,
    stockId: stock.id,
    side: order.side,
    requestedCash: order.side === "buy" ? order.frozenCash : undefined,
    requestedShares: order.side === "sell" ? order.shares : undefined,
    filledShares: shares,
    filledNotional: notional,
    avgPrice: price,
    finalPrice: price,
    unfilledCash: order.side === "buy" ? Math.max(0, (order.frozenCash ?? 0) - notional) : 0,
    unfilledShares: order.remainingShares,
    liquidityTakenPct: 0
  };

  if (order.owner === "player") {
    if (order.side === "buy") recordBuyFill(game, stock, shares, notional);
    else recordSellFill(game, stock, shares, notional);
    stock.volume -= shares;
    stock.turnover = roundMoney(stock.turnover - notional);
    playerFills.push(fill);
  } else if (order.owner === "whale" && order.ownerId) {
    const whale = game.whales.find((candidate) => candidate.id === order.ownerId);
    if (!whale) return;
    if (order.side === "buy") {
      whale.cash = roundMoney(whale.cash - notional);
      recordWhaleBuy(whale, stock, fill);
    } else {
      whale.cash = roundMoney(whale.cash + notional);
      recordWhaleSell(whale, stock, fill);
    }
    markWhaleToMarket(whale, game.stocks);
    whaleFills.push(fill);
  }
}

function expireUnusableAuctionOrders(stock: Stock): void {
  for (const order of stock.auction.orders) {
    if (order.status !== "open") continue;
    if (order.price < getLowerLimit(stock) || order.price > getUpperLimit(stock)) {
      order.status = "expired";
      order.remainingShares = 0;
    }
  }
}

function pushAuctionPrint(game: GameState, stock: Stock, kind: "auctionIndicative" | "auctionOpen"): void {
  const price = stock.auction.settled ? stock.price : stock.auction.referencePrice || stock.previousClose;
  const last = stock.chart.at(-1);
  if (last?.day === game.day && last.tick === game.tick) {
    last.price = price;
    last.kind = kind;
    return;
  }
  stock.chart.push({
    day: game.day,
    tick: game.tick,
    price,
    boardState: stock.boardState,
    kind
  });
}

function getReservedAuctionSellShares(stock: Stock): number {
  return stock.auction.orders
    .filter((order) => order.owner === "player" && order.side === "sell" && order.status === "open")
    .reduce((total, order) => total + order.remainingShares, 0);
}

function appendAuctionEvent(game: GameState, stock: Stock, message: string): void {
  game.eventLog.push({
    day: game.day,
    tick: game.tick,
    type: "auction",
    stockId: stock.id,
    message
  });
}
