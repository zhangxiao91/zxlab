import { describe, expect, it } from "vitest";
import {
  ambientDelay,
  chooseAmbientAction,
  directionIndex,
  spriteCell,
} from "./pet-motion";

describe("spriteCell", () => {
  it("maps standard rows and clamps their frames", () => {
    expect(spriteCell("waving", 2)).toEqual({ row: 3, column: 2 });
    expect(spriteCell("waving", 99)).toEqual({ row: 3, column: 3 });
  });

  it("maps the sixteen clockwise look directions across rows nine and ten", () => {
    expect(spriteCell("looking", 0)).toEqual({ row: 9, column: 0 });
    expect(spriteCell("looking", 7)).toEqual({ row: 9, column: 7 });
    expect(spriteCell("looking", 8)).toEqual({ row: 10, column: 0 });
    expect(spriteCell("looking", 15)).toEqual({ row: 10, column: 7 });
  });
});

describe("directionIndex", () => {
  it("uses screen coordinates in clockwise order from up", () => {
    expect(directionIndex(0, -10)).toBe(0);
    expect(directionIndex(10, 0)).toBe(4);
    expect(directionIndex(0, 10)).toBe(8);
    expect(directionIndex(-10, 0)).toBe(12);
  });
});

describe("ambient helpers", () => {
  it("does not immediately repeat the previous state", () => {
    expect(chooseAmbientAction("waving", 0).state).not.toBe("waving");
  });

  it("keeps ambient actions inside the quiet interval", () => {
    expect(ambientDelay(0)).toBe(14_000);
    expect(ambientDelay(1)).toBe(24_000);
  });
});
