import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTradingAction,
  parseTradingLocation,
  updateTradingLocation,
} from "../src/features/trading/route.ts";

const tradingUrl = (query = "") =>
  new URL(`https://zxlab.test/lab/trading${query}`);

test("trading route parser falls back to the overview risk workspace", () => {
  assert.deepEqual(parseTradingLocation(tradingUrl()), {
    view: "overview",
    mode: "risk",
  });
  assert.deepEqual(
    parseTradingLocation(
      tradingUrl("?view=unknown&mode=market&action=holdings"),
    ),
    { view: "overview", mode: "risk" },
  );
});

test("trading route parser accepts review mode only on review", () => {
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=review&mode=market")),
    { view: "review", mode: "market" },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=review&mode=unknown")),
    { view: "review", mode: "risk" },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=market&mode=market")),
    { view: "market", mode: "risk" },
  );
});

test("trading route parser keeps only actions valid for the active view", () => {
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=activity&action=import")),
    { view: "activity", mode: "risk", action: "import" },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=positions&action=holdings")),
    { view: "positions", mode: "risk", action: "holdings" },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=positions&action=import")),
    { view: "positions", mode: "risk" },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=activity&action=unknown")),
    { view: "activity", mode: "risk" },
  );
});

test("trading route updater canonicalizes owned parameters and preserves the rest", () => {
  const current = tradingUrl(
    "?view=review&mode=market&action=import&source=lab#runs",
  );
  const currentHref = current.href;
  const next = updateTradingLocation(current, {
    view: "positions",
    action: "holdings",
  });

  assert.equal(next.pathname, "/lab/trading");
  assert.equal(next.searchParams.get("view"), "positions");
  assert.equal(next.searchParams.get("mode"), null);
  assert.equal(next.searchParams.get("action"), "holdings");
  assert.equal(next.searchParams.get("source"), "lab");
  assert.equal(next.hash, "#runs");
  assert.equal(current.href, currentHref);
});

test("trading route updater clears stale mode and mismatched actions", () => {
  const current = tradingUrl("?view=review&mode=market&action=holdings");
  const next = updateTradingLocation(current, {
    view: "positions",
    action: "import",
  });

  assert.equal(next.searchParams.get("view"), "positions");
  assert.equal(next.searchParams.get("mode"), null);
  assert.equal(next.searchParams.get("action"), null);
  assert.deepEqual(
    parseTradingLocation(
      updateTradingLocation(current, { view: "review", mode: "risk" }),
    ),
    { view: "review", mode: "risk" },
  );
});

test("clearing a trading action is immutable and leaves other URL state intact", () => {
  const current = tradingUrl(
    "?view=activity&action=import&source=shortcut#activity",
  );
  const currentHref = current.href;
  const next = clearTradingAction(current);

  assert.equal(next.searchParams.get("action"), null);
  assert.equal(next.searchParams.get("view"), "activity");
  assert.equal(next.searchParams.get("source"), "shortcut");
  assert.equal(next.hash, "#activity");
  assert.equal(current.href, currentHref);
});

test("an action can be opened again after its route entry is cleared", () => {
  const base = tradingUrl("?view=activity");
  const opened = updateTradingLocation(base, {
    view: "activity",
    action: "import",
  });
  const closed = clearTradingAction(opened);
  const reopened = updateTradingLocation(closed, {
    view: "activity",
    action: "import",
  });

  assert.equal(parseTradingLocation(closed).action, undefined);
  assert.equal(parseTradingLocation(reopened).action, "import");
});
