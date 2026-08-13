import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPendingAnnotation,
  loadPendingAnnotation,
  savePendingAnnotation,
  type PendingAnnotation,
  type SessionStorageLike,
} from "../src/features/briefing/pending-annotation.ts";

function memoryStorage(): SessionStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const draft: PendingAnnotation = {
  briefingId: "briefing-1",
  briefingItemId: "item-1",
  itemTitle: "Signal item",
  selectedText: "A preserved selection",
  comment: "A preserved comment",
  action: "comment",
};

test("pending annotation survives a same-tab Access round trip until the send succeeds", () => {
  const storage = memoryStorage();

  savePendingAnnotation(storage, draft);
  assert.deepEqual(loadPendingAnnotation(storage), draft);

  clearPendingAnnotation(storage);
  assert.equal(loadPendingAnnotation(storage), null);
});

test("pending annotation storage fails closed for malformed or incomplete browser state", () => {
  const storage = memoryStorage();
  storage.setItem("zxlab:pending-signal-annotation", "not-json");
  assert.equal(loadPendingAnnotation(storage), null);

  storage.setItem("zxlab:pending-signal-annotation", JSON.stringify({ ...draft, comment: "" }));
  assert.equal(loadPendingAnnotation(storage), null);
});
