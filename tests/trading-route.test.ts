import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTradingDetail,
  createTradingRoute,
  parseTradingLocation,
  updateTradingLocation,
  type TradingHistoryAdapter,
} from "../src/features/trading/route.ts";

const tradingUrl = (query = "") =>
  new URL(`https://zxlab.test/lab/trading${query}`);

class MemoryHistory implements TradingHistoryAdapter {
  private entries: string[];
  private index = 0;
  private listeners = new Set<() => void>();
  readonly mutations: Array<{ method: "push" | "replace"; href: string }> = [];

  constructor(initialHref: string) {
    this.entries = [initialHref];
  }

  getHref() {
    return this.entries[this.index];
  }

  push(href: string) {
    this.entries.splice(this.index + 1, Infinity, href);
    this.index += 1;
    this.mutations.push({ method: "push", href });
  }

  replace(href: string) {
    this.entries[this.index] = href;
    this.mutations.push({ method: "replace", href });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  back() {
    if (this.index === 0) return;
    this.index -= 1;
    this.emitPopState();
  }

  forward() {
    if (this.index === this.entries.length - 1) return;
    this.index += 1;
    this.emitPopState();
  }

  private emitPopState() {
    for (const listener of this.listeners) listener();
  }
}

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

test("legacy import actions decode into route-owned details", () => {
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=activity&action=import")),
    {
      view: "activity",
      mode: "risk",
      detail: { kind: "transaction-import" },
    },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=positions&action=holdings")),
    {
      view: "positions",
      mode: "risk",
      detail: { kind: "holdings-import" },
    },
  );
  assert.deepEqual(
    parseTradingLocation(tradingUrl("?view=positions&action=import")),
    { view: "positions", mode: "risk" },
  );
});

test("risk and agent evidence routes require complete compatible identity", () => {
  assert.deepEqual(
    parseTradingLocation(
      tradingUrl("?view=overview&action=evidence&evidence=metric%3Anet"),
    ),
    {
      view: "overview",
      mode: "risk",
      detail: { kind: "risk-evidence", evidenceId: "metric:net" },
    },
  );
  assert.deepEqual(
    parseTradingLocation(
      tradingUrl(
        "?view=review&mode=market&action=evidence&run=run-7&evidence=event-2",
      ),
    ),
    {
      view: "review",
      mode: "market",
      detail: {
        kind: "agent-evidence",
        runId: "run-7",
        evidenceId: "event-2",
      },
    },
  );
  assert.deepEqual(
    parseTradingLocation(
      tradingUrl("?view=market&action=evidence&evidence=event-2"),
    ),
    { view: "market", mode: "risk" },
  );
  assert.deepEqual(
    parseTradingLocation(
      tradingUrl("?view=review&mode=market&action=evidence&evidence=event-2"),
    ),
    { view: "review", mode: "market" },
  );
});

test("agent Run selection round-trips without requiring an Evidence item", () => {
  const location = parseTradingLocation(tradingUrl("?view=review&mode=market&run=run-7"));
  assert.deepEqual(location, {
    view: "review",
    mode: "market",
    detail: { kind: "agent-run", runId: "run-7" },
  });

  const encoded = updateTradingLocation(tradingUrl("?source=history"), {
    view: "review",
    mode: "market",
    detail: { kind: "agent-run", runId: "run-8" },
  });
  assert.equal(encoded.searchParams.get("run"), "run-8");
  assert.equal(encoded.searchParams.get("action"), null);
  assert.equal(encoded.searchParams.get("evidence"), null);
  assert.deepEqual(parseTradingLocation(encoded).detail, { kind: "agent-run", runId: "run-8" });
});

test("trading route updater canonicalizes owned parameters and preserves the rest", () => {
  const current = tradingUrl(
    "?view=review&mode=market&action=evidence&evidence=old&run=old-run&source=lab#runs",
  );
  const currentHref = current.href;
  const next = updateTradingLocation(current, {
    view: "positions",
    detail: { kind: "holdings-import" },
  });

  assert.equal(next.pathname, "/lab/trading");
  assert.equal(next.searchParams.get("view"), "positions");
  assert.equal(next.searchParams.get("mode"), null);
  assert.equal(next.searchParams.get("action"), "holdings");
  assert.equal(next.searchParams.get("evidence"), null);
  assert.equal(next.searchParams.get("run"), null);
  assert.equal(next.searchParams.get("source"), "lab");
  assert.equal(next.hash, "#runs");
  assert.equal(current.href, currentHref);
});

test("detail codec round-trips agent evidence and drops mismatched details", () => {
  const current = tradingUrl("?source=deep-link#evidence");
  const agent = updateTradingLocation(current, {
    view: "review",
    mode: "market",
    detail: {
      kind: "agent-evidence",
      runId: "run/a",
      evidenceId: "evidence:a",
    },
  });

  assert.deepEqual(parseTradingLocation(agent), {
    view: "review",
    mode: "market",
    detail: {
      kind: "agent-evidence",
      runId: "run/a",
      evidenceId: "evidence:a",
    },
  });
  assert.equal(agent.searchParams.get("source"), "deep-link");
  assert.equal(agent.hash, "#evidence");

  const mismatched = updateTradingLocation(agent, {
    view: "market",
    detail: { kind: "risk-evidence", evidenceId: "risk-1" },
  });
  assert.deepEqual(parseTradingLocation(mismatched), {
    view: "market",
    mode: "risk",
  });
  assert.equal(mismatched.searchParams.get("action"), null);
  assert.equal(mismatched.searchParams.get("evidence"), null);
  assert.equal(mismatched.searchParams.get("run"), null);
});

test("clearing a trading detail is immutable and leaves other URL state intact", () => {
  const current = tradingUrl(
    "?view=review&mode=market&action=evidence&evidence=e-1&run=r-1&source=shortcut#activity",
  );
  const currentHref = current.href;
  const next = clearTradingDetail(current);

  assert.equal(next.searchParams.get("action"), null);
  assert.equal(next.searchParams.get("evidence"), null);
  assert.equal(next.searchParams.get("run"), null);
  assert.equal(next.searchParams.get("view"), "review");
  assert.equal(next.searchParams.get("mode"), "market");
  assert.equal(next.searchParams.get("source"), "shortcut");
  assert.equal(next.hash, "#activity");
  assert.equal(current.href, currentHref);
});

test("route intents own push and replace semantics", () => {
  const history = new MemoryHistory(
    tradingUrl("?view=overview&source=shell#workspace").href,
  );
  const route = createTradingRoute(history);
  let notifications = 0;
  route.subscribe(() => notifications += 1);

  route.send({ type: "navigate", view: "positions" });
  assert.deepEqual(route.getSnapshot(), { view: "positions", mode: "risk" });
  assert.equal(history.mutations.at(-1)?.method, "push");

  route.send({ type: "open-detail", detail: { kind: "holdings-import" } });
  assert.deepEqual(route.getSnapshot(), {
    view: "positions",
    mode: "risk",
    detail: { kind: "holdings-import" },
  });
  assert.equal(history.mutations.at(-1)?.method, "push");
  assert.equal(new URL(history.getHref()).searchParams.get("source"), "shell");
  assert.equal(new URL(history.getHref()).hash, "#workspace");

  route.send({ type: "close-detail" });
  assert.deepEqual(route.getSnapshot(), { view: "positions", mode: "risk" });
  assert.equal(history.mutations.at(-1)?.method, "replace");
  assert.equal(notifications, 3);
});

test("opening the current Run or Evidence does not pollute browser history", () => {
  const history = new MemoryHistory(
    tradingUrl("?view=review&mode=market&run=run-1").href,
  );
  const route = createTradingRoute(history);

  route.send({ type: "open-detail", detail: { kind: "agent-run", runId: "run-1" } });
  assert.equal(history.mutations.length, 0);

  route.send({ type: "open-detail", detail: { kind: "agent-evidence", runId: "run-1", evidenceId: "e-1" } });
  assert.equal(history.mutations.length, 1);
  route.send({ type: "open-detail", detail: { kind: "agent-evidence", runId: "run-1", evidenceId: "e-1" } });
  assert.equal(history.mutations.length, 1);
});

test("navigation retains compatible detail and clears incompatible detail", () => {
  const history = new MemoryHistory(tradingUrl("?view=overview").href);
  const route = createTradingRoute(history);

  route.send({
    type: "open-detail",
    detail: { kind: "risk-evidence", evidenceId: "risk-7" },
  });
  route.send({ type: "navigate", view: "positions" });
  assert.deepEqual(route.getSnapshot(), {
    view: "positions",
    mode: "risk",
    detail: { kind: "risk-evidence", evidenceId: "risk-7" },
  });

  route.send({ type: "navigate", view: "review", reviewMode: "market" });
  assert.deepEqual(route.getSnapshot(), { view: "review", mode: "market" });
  const url = new URL(history.getHref());
  assert.equal(url.searchParams.get("action"), null);
  assert.equal(url.searchParams.get("evidence"), null);
});

test("open-detail selects the detail's owning workspace when needed", () => {
  const history = new MemoryHistory(tradingUrl("?view=market").href);
  const route = createTradingRoute(history);

  route.send({
    type: "open-detail",
    detail: {
      kind: "agent-evidence",
      runId: "run-9",
      evidenceId: "evidence-3",
    },
  });

  assert.deepEqual(route.getSnapshot(), {
    view: "review",
    mode: "market",
    detail: {
      kind: "agent-evidence",
      runId: "run-9",
      evidenceId: "evidence-3",
    },
  });
});

test("route synchronizes back and forward popstate without exposing history", () => {
  const history = new MemoryHistory(tradingUrl("?view=overview").href);
  const route = createTradingRoute(history);
  const snapshots: string[] = [];
  route.subscribe(() => snapshots.push(JSON.stringify(route.getSnapshot())));

  route.send({ type: "navigate", view: "activity" });
  route.send({ type: "open-detail", detail: { kind: "transaction-import" } });
  history.back();
  assert.deepEqual(route.getSnapshot(), { view: "activity", mode: "risk" });
  history.forward();
  assert.deepEqual(route.getSnapshot(), {
    view: "activity",
    mode: "risk",
    detail: { kind: "transaction-import" },
  });
  assert.equal(snapshots.length, 4);

  route.destroy();
  history.back();
  assert.deepEqual(route.getSnapshot(), {
    view: "activity",
    mode: "risk",
    detail: { kind: "transaction-import" },
  });
});
