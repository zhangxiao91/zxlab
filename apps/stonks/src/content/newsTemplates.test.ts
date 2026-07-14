import { describe, expect, it } from "vitest";
import { sectors } from "./sectors";
import { createStocks } from "./stocks";
import { newsTemplates } from "./newsTemplates";

describe("newsTemplates", () => {
  it("contains 28 unique reusable news templates", () => {
    const ids = new Set(newsTemplates.map((template) => template.id));

    expect(newsTemplates).toHaveLength(28);
    expect(ids.size).toBe(newsTemplates.length);
  });

  it("uses valid sector and stock targets", () => {
    const sectorIds = new Set(Object.keys(sectors));
    const stockIds = new Set(Object.keys(createStocks()));

    for (const template of newsTemplates) {
      expect(template.remainingDays).toBe(template.durationDays);
      if (template.scope === "market") {
        expect(template.targetId).toBeUndefined();
      } else if (template.scope === "sector") {
        expect(sectorIds.has(template.targetId ?? "")).toBe(true);
      } else {
        expect(stockIds.has(template.targetId ?? "")).toBe(true);
      }
    }
  });
});
