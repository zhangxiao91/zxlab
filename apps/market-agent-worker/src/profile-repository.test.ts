import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWatchlist } from "./profile-repository.ts";

test("watchlist normalization is explicit, bounded and duplicate-safe", () => {
  assert.deepEqual(normalizeWatchlist([{ instrumentId: "sse:600000", reason: " 核心观察 " }]), [{ instrumentId: "SSE:600000", reason: "核心观察" }]);
  assert.throws(() => normalizeWatchlist([{ instrumentId: "SSE:600000" }, { instrumentId: "sse:600000" }]), /INVALID_WATCHLIST/);
  assert.throws(() => normalizeWatchlist([{ instrumentId: "NASDAQ:AAPL" }]), /INVALID_WATCHLIST/);
});
