import { describe, expect, it } from "vitest";
import { createInitialGame } from "../game/createInitialGame";
import { calculateEtfNav } from "./etfEngine";
import { advanceToIntraday } from "./scenarioTools";
import { updateTick } from "./tick";

describe("ETF engine", () => {
  it("creates the first-stage ETF universe", () => {
    const game = createInitialGame("etf-universe-test");
    const etfs = Object.values(game.stocks).filter((stock) => stock.assetType === "etf");

    expect(etfs).toHaveLength(5);
    expect(game.stocks.ETF_BROAD_MARKET.etf?.components.length).toBeGreaterThan(4);
    expect(game.stocks.ETF_TECH_GROWTH.etf?.components.some((component) => component.stockId === "DRAGON_SOFT")).toBe(true);
  });

  it("calculates NAV from component stock returns", () => {
    const game = createInitialGame("etf-nav-test");
    const etf = game.stocks.ETF_TECH_GROWTH;
    const initialNav = calculateEtfNav(game, etf);

    game.stocks.DRAGON_SOFT.price *= 1.1;
    const nextNav = calculateEtfNav(game, etf);

    expect(initialNav).toBeCloseTo(etf.etf?.basePrice ?? 0, 2);
    expect(nextNav).toBeGreaterThan(initialNav);
    expect(nextNav).toBeLessThan(initialNav * 1.05);
  });

  it("trades ETFs during continuous auction while keeping price close to NAV", () => {
    const game = createInitialGame("etf-trading-test");
    advanceToIntraday(game);

    const result = updateTick(game, [{ type: "marketBuy", stockId: "ETF_TECH_GROWTH", amountCash: 2_000_000 }], { detail: "full" });
    const trace = result.stocks.find((stock) => stock.stockId === "ETF_TECH_GROWTH");
    const etf = game.stocks.ETF_TECH_GROWTH;
    const nav = calculateEtfNav(game, etf);

    expect(trace).toBeDefined();
    expect(result.playerFills.some((fill) => fill.stockId === "ETF_TECH_GROWTH" && fill.side === "buy")).toBe(true);
    expect(game.player.positions.ETF_TECH_GROWTH?.lockedShares ?? 0).toBeGreaterThan(0);
    expect(Math.abs(etf.price / nav - 1)).toBeLessThan(0.035);
  });
});
