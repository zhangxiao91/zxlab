import { clamp, roundMoney } from "../game/config";
import { syncDailyCandle } from "../game/charting";
import { createRng } from "../game/rng";
import type { GameState, Pressure, Stock, StockTickTrace } from "../game/types";
import { processPlayerOrdersForStock } from "../player/actions";
import { getLowerLimit, getUpperLimit, roundPrice } from "./boardEngine";
import { createMarketDepth } from "./marketDepth";
import { createPressure } from "./priceEngine";

export function calculateEtfNav(game: GameState, etf: Stock): number {
  if (!etf.etf) return etf.price;

  const relativeValue = etf.etf.components.reduce((total, component) => {
    const underlying = game.stocks[component.stockId];
    if (!underlying || component.basePrice <= 0) return total;
    return total + component.weight * (underlying.price / component.basePrice);
  }, 0);

  return roundMoney(etf.etf.components.length > 0 ? etf.etf.basePrice * relativeValue : etf.price);
}

export function processEtfMarketTick(game: GameState, etf: Stock, playerActions: Parameters<typeof processPlayerOrdersForStock>[3]): StockTickTrace {
  const priceBefore = etf.price;
  const nav = calculateEtfNav(game, etf);
  const oldPremium = etf.etf?.premiumDiscount ?? 0;
  const arbitrageNotional = Math.abs(nav - etf.price) / Math.max(0.01, nav) * etf.currentLiquidity * 9;
  const basePressure = createPressure(game, etf, {
    institutionBuyPressure: nav > etf.price ? arbitrageNotional : 0,
    institutionSellPressure: nav < etf.price ? arbitrageNotional : 0,
    noise: 0
  });
  const depth = createMarketDepth(etf, basePressure);
  const player = processPlayerOrdersForStock(game, etf, depth, playerActions);
  const playerBuy = player.fills.filter((fill) => fill.side === "buy").reduce((total, fill) => total + fill.filledNotional, 0);
  const playerSell = player.fills.filter((fill) => fill.side === "sell").reduce((total, fill) => total + fill.filledNotional, 0);
  const pressure = createPressure(game, etf, {
    institutionBuyPressure: nav > etf.price ? arbitrageNotional : 0,
    institutionSellPressure: nav < etf.price ? arbitrageNotional : 0,
    playerBuyPressure: player.buyPressure,
    playerSellPressure: player.sellPressure,
    noise: 0
  });

  updateEtfPriceFromNav(game, etf, nav, oldPremium, playerBuy - playerSell);
  const finalDepth = createMarketDepth(etf, pressure);

  return {
    stockId: etf.id,
    name: etf.name,
    marketCapClass: "large",
    priceBefore,
    priceAfter: etf.price,
    changePct: ((etf.price - etf.previousClose) / etf.previousClose) * 100,
    boardState: etf.boardState,
    buyQueue: etf.buyQueue,
    sellQueue: etf.sellQueue,
    boardStrength: etf.boardStrength,
    currentLiquidity: etf.currentLiquidity,
    effectiveDepth: finalDepth.effectiveDepth,
    bidNotional: finalDepth.bidNotional,
    askNotional: finalDepth.askNotional,
    pressure,
    playerFills: player.fills,
    restingOrders: player.restingOrders,
    whaleTrades: [],
    heatCauses: buildEtfHeatCauses(etf, pressure)
  };
}

function updateEtfPriceFromNav(game: GameState, etf: Stock, nav: number, oldPremium: number, playerFlow: number): void {
  const rng = createRng(`${game.rngSeed}:etf:${game.day}:${game.tick}:${etf.id}`);
  const flowPremium = clamp(playerFlow / Math.max(1, etf.currentLiquidity) * 0.018, -0.009, 0.009);
  const trackingNoise = rng.float(-1, 1) * (etf.etf?.trackingError ?? 0.003);
  const nextPremium = clamp(oldPremium * 0.78 + flowPremium + trackingNoise, -0.026, 0.026);
  const boundedPrice = clamp(roundPrice(nav * (1 + nextPremium)), getLowerLimit(etf), getUpperLimit(etf));

  etf.price = boundedPrice;
  etf.microPrice = boundedPrice;
  etf.high = Math.max(etf.high, boundedPrice);
  etf.low = Math.min(etf.low, boundedPrice);
  etf.momentum = clamp(((boundedPrice - etf.previousClose) / Math.max(0.01, etf.previousClose)) * 1000, -100, 100);
  etf.sentiment = clamp(etf.sentiment * 0.96 + (boundedPrice >= etf.previousClose ? 54 : 46) * 0.04, 0, 100);
  etf.attention = clamp(etf.attention * 0.97 + Math.abs(etf.momentum) * 0.025, 0, 100);
  etf.heat = clamp(etf.heat * 0.985 + Math.abs(nextPremium) * 120, 0, 100);
  etf.microstructure.flowMemory = clamp(nextPremium * 900, -18, 18);
  etf.microstructure.shockMemory = clamp(((boundedPrice / Math.max(0.01, etf.previousClose) - 1) * 100) * 4, -28, 28);
  etf.microstructure.lastPrintSign = boundedPrice > etf.previousClose ? 1 : boundedPrice < etf.previousClose ? -1 : 0;
  etf.boardState = "loose";
  etf.buyQueue = 0;
  etf.sellQueue = 0;
  etf.boardStrength = 0;
  if (etf.etf) {
    etf.etf.nav = nav;
    etf.etf.premiumDiscount = roundMoney((boundedPrice / Math.max(0.01, nav) - 1) * 10_000) / 10_000;
  }

  etf.chart.push({
    day: game.day,
    tick: game.tick,
    price: etf.price,
    boardState: etf.boardState,
    kind: "trade"
  });
  syncDailyCandle(etf, game.day);
}

function buildEtfHeatCauses(etf: Stock, pressure: Pressure): StockTickTrace["heatCauses"] {
  const causes: StockTickTrace["heatCauses"] = [];
  if (Math.abs(etf.etf?.premiumDiscount ?? 0) > 0.006) {
    causes.push({
      source: "fundamental",
      heatDelta: Math.abs(etf.etf?.premiumDiscount ?? 0) * 24,
      note: "ETF premium/discount widened against NAV"
    });
  }
  if (pressure.playerBuyPressure > 0 || pressure.playerSellPressure > 0) {
    causes.push({
      source: "player",
      heatDelta: Math.max(pressure.playerBuyPressure, pressure.playerSellPressure) / Math.max(1, etf.currentLiquidity) * 0.12,
      buyPressure: pressure.playerBuyPressure,
      sellPressure: pressure.playerSellPressure,
      note: "player flow nudged ETF premium/discount"
    });
  }
  return causes;
}
