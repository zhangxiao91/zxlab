import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";

function withStore(run: (store: Store) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-bot-test-"));
  const store = new Store(path.join(directory, "bot.db"));
  try {
    run(store);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("binds only the first owner and rejects later users", () => withStore((store) => {
  assert.deepEqual(store.authorizeUser("user-a", undefined, true), {
    allowed: true,
    boundNow: true,
    ownerUserId: "user-a",
  });
  assert.deepEqual(store.authorizeUser("user-b", undefined, true), {
    allowed: false,
    boundNow: false,
    ownerUserId: "user-a",
  });
  assert.equal(store.authorizeUser("user-a", undefined, true).allowed, true);
}));

test("ALLOWED_USER_ID overrides the stored owner", () => withStore((store) => {
  store.authorizeUser("stored-owner", undefined, true);
  assert.equal(store.authorizeUser("configured-owner", "configured-owner", true).allowed, true);
  assert.equal(store.authorizeUser("stored-owner", "configured-owner", true).allowed, false);
}));

test("does not bind an owner when bootstrap is disabled", () => withStore((store) => {
  assert.deepEqual(store.authorizeUser("user-a", undefined, false), {
    allowed: false,
    boundNow: false,
  });
  assert.equal(store.getSetting("owner_user_id"), undefined);
}));

test("deduplicates incoming and persisted platform messages", () => withStore((store) => {
  assert.equal(store.claimIncomingMessage("message-1"), true);
  assert.equal(store.claimIncomingMessage("message-1"), false);
  assert.equal(store.addUserMessage("message-1", "owner", "hello"), true);
  assert.equal(store.addUserMessage("message-1", "owner", "hello again"), false);
  assert.equal(store.countMessages("owner"), 1);
}));

test("trims context from the oldest side by count and character budget", () => withStore((store) => {
  store.addUserMessage("1", "owner", "1111");
  store.addAssistantMessage("owner", "2222");
  store.addUserMessage("2", "owner", "3333");
  assert.deepEqual(store.getRecentMessages("owner", 2, 6), [
    { role: "assistant", content: "22" },
    { role: "user", content: "3333" },
  ]);
}));

test("reset clears conversation but preserves owner binding", () => withStore((store) => {
  store.authorizeUser("owner", undefined, true);
  store.addUserMessage("1", "owner", "hello");
  assert.equal(store.resetConversation("owner"), 1);
  assert.equal(store.countMessages("owner"), 0);
  assert.equal(store.authorizeUser("owner", undefined, true).allowed, true);
}));
