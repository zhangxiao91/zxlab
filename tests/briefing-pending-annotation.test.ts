import assert from "node:assert/strict";
import test from "node:test";
import {
  clearPendingAnnotation,
  loadPendingAnnotation,
  reservePendingAnnotation,
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
  idempotencyKey: "5cab3051-247e-47b9-b90a-630a1a5b8067",
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

test("pending annotation reuses its idempotency key only for the same request", () => {
  const storage = memoryStorage();
  const { idempotencyKey: _ignored, ...request } = draft;
  const first = reservePendingAnnotation(storage, request, () => draft.idempotencyKey);
  const same = reservePendingAnnotation(storage, request, () => "1b2a43a4-1456-4d50-8ae1-1ab59adfd444");
  const changed = reservePendingAnnotation(storage, { ...request, comment: "A changed comment" },
    () => "1b2a43a4-1456-4d50-8ae1-1ab59adfd444");

  assert.equal(first.idempotencyKey, draft.idempotencyKey);
  assert.equal(same.idempotencyKey, draft.idempotencyKey);
  assert.equal(changed.idempotencyKey, "1b2a43a4-1456-4d50-8ae1-1ab59adfd444");
});

test("pending annotation storage fails closed for malformed or incomplete browser state", () => {
  const storage = memoryStorage();
  storage.setItem("zxlab:pending-signal-annotation", "not-json");
  assert.equal(loadPendingAnnotation(storage), null);

  storage.setItem("zxlab:pending-signal-annotation", JSON.stringify({ ...draft, comment: "" }));
  assert.equal(loadPendingAnnotation(storage), null);

  storage.setItem("zxlab:pending-signal-annotation", JSON.stringify({ ...draft, idempotencyKey: "browser-controlled" }));
  assert.equal(loadPendingAnnotation(storage), null);
});
