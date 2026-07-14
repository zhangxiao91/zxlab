import { describe, expect, it } from "vitest";
import { roundMoney } from "../game/config";
import { createInitialGame } from "../game/createInitialGame";
import type { AuctionOrder, Stock } from "../game/types";
import { getLowerLimit, getUpperLimit, roundPrice } from "./boardEngine";
import {
  canCancelAuctionOrder,
  canSubmitAuctionOrder,
  determineAuctionPrice,
  getAuctionPhaseForTick
} from "./auctionEngine";
import { updateTick } from "./tick";

function prepareStock(stock: Stock, previousClose = 10): Stock {
  stock.previousClose = previousClose;
  stock.price = previousClose;
  stock.open = previousClose;
  stock.high = previousClose;
  stock.low = previousClose;
  stock.auction.orders = [];
  stock.auction.referencePrice = previousClose;
  return stock;
}

function order(stock: Stock, id: string, side: "buy" | "sell", price: number, shares: number): AuctionOrder {
  return {
    id,
    owner: "synthetic",
    stockId: stock.id,
    side,
    price,
    shares,
    remainingShares: shares,
    cancellable: true,
    submittedDay: 1,
    submittedTick: 6,
    status: "open"
  };
}

describe("opening auction engine", () => {
  it("selects the price with maximum executable volume", () => {
    const stock = prepareStock(createInitialGame("auction-max-volume").stocks.DRAGON_SOFT);
    const result = determineAuctionPrice(stock, [
      order(stock, "b1", "buy", 10.2, 100),
      order(stock, "b2", "buy", 9.9, 40),
      order(stock, "s1", "sell", 9.8, 90),
      order(stock, "s2", "sell", 10.1, 80)
    ]);

    expect(result.price).toBe(10.1);
    expect(result.matchedShares).toBe(100);
  });

  it("breaks equal-volume ties by smaller unmatched imbalance, then closest to previous close", () => {
    const stock = prepareStock(createInitialGame("auction-tie-break").stocks.DRAGON_SOFT);
    const smallerImbalance = determineAuctionPrice(stock, [
      order(stock, "b1", "buy", 10.4, 100),
      order(stock, "b2", "buy", 10.2, 40),
      order(stock, "s1", "sell", 10.1, 100),
      order(stock, "s2", "sell", 10.4, 20)
    ]);
    const closestPreviousClose = determineAuctionPrice(stock, [
      order(stock, "b1", "buy", 10.1, 100),
      order(stock, "s1", "sell", 9.8, 100)
    ]);

    expect(smallerImbalance.price).toBe(10.4);
    expect(smallerImbalance.matchedShares).toBe(100);
    expect(smallerImbalance.sellRemainingShares).toBe(20);
    expect(closestPreviousClose.price).toBe(10);
    expect(closestPreviousClose.matchedShares).toBe(100);
  });

  it("keeps the auction price inside daily limit boundaries", () => {
    const stock = prepareStock(createInitialGame("auction-limit-boundary").stocks.DRAGON_SOFT);
    const upper = getUpperLimit(stock);
    const lower = getLowerLimit(stock);
    const highDemand = determineAuctionPrice(stock, [
      order(stock, "b1", "buy", upper * 1.5, 1_000),
      order(stock, "s1", "sell", upper, 600)
    ]);
    const lowDemand = determineAuctionPrice(stock, [
      order(stock, "b1", "buy", lower, 600),
      order(stock, "s1", "sell", lower * 0.5, 1_000)
    ]);

    expect(highDemand.price).toBe(upper);
    expect(lowDemand.price).toBe(lower);
    expect(highDemand.price).toBeLessThanOrEqual(upper);
    expect(lowDemand.price).toBeGreaterThanOrEqual(lower);
  });

  it("maps ticks to pre-open, cancelable, locked, match, break, and continuous states", () => {
    expect(getAuctionPhaseForTick(0)).toBe("preOpen");
    expect(getAuctionPhaseForTick(6)).toBe("cancelable");
    expect(getAuctionPhaseForTick(16)).toBe("locked");
    expect(getAuctionPhaseForTick(25)).toBe("match");
    expect(getAuctionPhaseForTick(26)).toBe("break");
    expect(getAuctionPhaseForTick(31)).toBe("continuous");
    expect(canSubmitAuctionOrder(5)).toBe(false);
    expect(canSubmitAuctionOrder(6)).toBe(true);
    expect(canSubmitAuctionOrder(24)).toBe(true);
    expect(canSubmitAuctionOrder(26)).toBe(false);
    expect(canCancelAuctionOrder(15)).toBe(true);
    expect(canCancelAuctionOrder(16)).toBe(false);
  });

  it("freezes, cancels, locks, matches, and refunds player auction orders through the opening timeline", () => {
    const game = createInitialGame("auction-player-accounting");
    const stock = game.stocks.DRAGON_SOFT;
    const openingCash = game.player.cash;

    updateTick(game, [{ type: "marketBuy", stockId: stock.id, amountCash: 1_000_000, limitPrice: stock.price }], { detail: "full" });
    expect(game.player.cash).toBe(openingCash);
    expect(stock.auction.orders.filter((candidate) => candidate.owner === "player")).toHaveLength(0);

    while (game.tick < 6) updateTick(game, [], { detail: "full" });
    updateTick(game, [{ type: "marketBuy", stockId: stock.id, amountCash: 1_000_000, limitPrice: stock.price }], { detail: "full" });
    const cancelableOrder = stock.auction.orders.find((candidate) => candidate.owner === "player" && candidate.status === "open");
    expect(cancelableOrder).toBeDefined();
    expect(game.player.cash).toBeLessThan(openingCash);

    updateTick(game, [{ type: "cancelAuctionOrder", orderId: cancelableOrder!.id }], { detail: "full" });
    expect(game.player.cash).toBe(openingCash);
    expect(cancelableOrder?.status).toBe("cancelled");

    while (game.tick < 16) updateTick(game, [], { detail: "full" });
    const lockedLimit = roundPrice(stock.price * 1.04);
    updateTick(game, [{ type: "marketBuy", stockId: stock.id, amountCash: 1_000_000, limitPrice: lockedLimit }], { detail: "full" });
    const lockedOrder = stock.auction.orders.find((candidate) => candidate.owner === "player" && candidate.status === "open");
    expect(lockedOrder).toBeDefined();
    expect(lockedOrder?.cancellable).toBe(false);
    const frozenCash = game.player.cash;

    updateTick(game, [{ type: "cancelAuctionOrder", orderId: lockedOrder!.id }], { detail: "full" });
    expect(lockedOrder?.status).toBe("open");
    expect(game.player.cash).toBe(frozenCash);

    stock.auction.orders.push(order(stock, "forced-sell", "sell", lockedLimit, lockedOrder!.remainingShares));
    while (game.tick < 25) updateTick(game, [], { detail: "full" });
    const match = updateTick(game, [], { detail: "full" });
    const playerFill = match.playerFills.find((fill) => fill.stockId === stock.id && fill.side === "buy");

    expect(playerFill).toBeDefined();
    expect(game.player.cash).toBe(roundMoney(openingCash - playerFill!.filledNotional));
    expect(game.player.positions[stock.id]?.lockedShares ?? 0).toBeGreaterThan(0);
    expect(stock.auction.settled).toBe(true);

    const afterMatchCash = game.player.cash;
    updateTick(game, [{ type: "marketBuy", stockId: stock.id, amountCash: 500_000, limitPrice: stock.price }], { detail: "full" });
    expect(game.tick).toBe(27);
    expect(game.player.cash).toBe(afterMatchCash);
  });
});
