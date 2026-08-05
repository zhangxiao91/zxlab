import assert from "node:assert/strict";
import test from "node:test";
import { validateBrowserRunIntent } from "@zxlab/market-agent-schema";
import { MemoryRunRepository } from "./foundation.ts";

test("browser intent cannot select profile or trigger", () => assert.ok(validateBrowserRunIntent({ workflow: "close_review", idempotencyKey: "request-123", profileId: "forged" }).includes("profileId and trigger are server-only")));
test("run creation is idempotent and rejects hash reuse", async () => {
  const repo = new MemoryRunRepository();
  const command = { workflow: "close_review" as const, idempotencyKey: "request-123", profileId: "p1", trigger: "manual" as const };
  const first = await repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:a" });
  const second = await repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:a" });
  assert.equal(first.run.id, second.run.id); assert.equal(second.created, false);
  await assert.rejects(() => repo.createQueued(command, { command, actorScope: "p1", commandHash: "sha256:b" }), /IDEMPOTENCY_KEY_REUSED/);
});
