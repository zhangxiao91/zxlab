import { describe, expect, it } from "vitest";
import { createInitialGame } from "../game/createInitialGame";
import { choosePreMarketNewsCount, getMiddayNewsProbability, sampleScheduledNews } from "./newsEngine";
import { updateTick } from "./tick";

describe("scheduled news sampling", () => {
  it("leans toward fewer pre-market items as active news count rises", () => {
    expect(choosePreMarketNewsCount(0, 0.74)).toBe(3);
    expect(choosePreMarketNewsCount(10, 0.74)).toBe(1);
  });

  it("reduces midday news probability when the tape is already busy", () => {
    expect(getMiddayNewsProbability(1)).toBeGreaterThan(getMiddayNewsProbability(8));
    expect(getMiddayNewsProbability(20)).toBeGreaterThanOrEqual(0.06);
  });

  it("adds one to three deterministic news items before the opening auction", () => {
    const game = createInitialGame("scheduled-pre-market-news");
    const initialNewsCount = game.news.length;
    const result = updateTick(game, [], { detail: "full" });
    const generated = result.events.filter((event) => event.type === "newsGenerated");

    expect(generated.length).toBeGreaterThanOrEqual(1);
    expect(generated.length).toBeLessThanOrEqual(3);
    expect(game.news).toHaveLength(initialNewsCount + generated.length);
    expect(new Set(game.news.map((item) => item.id)).size).toBe(game.news.length);
  });

  it("samples at most one midday item and does not duplicate a generated tick", () => {
    const game = createInitialGame("scheduled-midday-news");
    game.news = [];
    game.day = 3;
    game.tick = 120;
    game.phase = "intraday";

    const first = sampleScheduledNews(game);
    const second = sampleScheduledNews(game);

    expect(first.length).toBeLessThanOrEqual(1);
    expect(second).toHaveLength(first.length > 0 ? 0 : second.length);
  });
});
