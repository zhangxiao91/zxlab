import assert from "node:assert/strict";
import test from "node:test";
import { defaultMarketWatchlist, loadMarketWatchlist, saveMarketWatchlist, toWatchlistItem } from "../src/features/market/watchlist.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("new market workspaces have no implied watchlist", () => {
  assert.deepEqual(defaultMarketWatchlist(), []);
  assert.deepEqual(loadMarketWatchlist(new MemoryStorage()), []);
});

test("legacy product defaults are migrated away without deleting user choices", () => {
  const storage = new MemoryStorage();
  storage.setItem("zxlab.market.watchlist.v1", JSON.stringify([
    toWatchlistItem("SSE:512480", "当前 Risk 账本默认标的"),
    toWatchlistItem("SZSE:159995", "当前 Risk 账本默认标的"),
    toWatchlistItem("SSE:513100", "当前 Risk 账本默认标的"),
  ]));
  assert.deepEqual(loadMarketWatchlist(storage), []);

  const manual = toWatchlistItem("SSE:512480", "手动添加");
  assert.ok(manual);
  saveMarketWatchlist(storage, [manual]);
  assert.deepEqual(loadMarketWatchlist(storage), [manual]);
});
