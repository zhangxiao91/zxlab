import assert from "node:assert/strict";
import test from "node:test";
import { signActorEnvelope, subjectHash, verifyActorEnvelope } from "@zxlab/market-agent-schema";

test("signed actor envelope binds Access subject and expires", async () => {
  const payload = { version: 1 as const, subject: "access-user-1", email: "owner@example.com", audience: "market-agent" as const, expiresAt: 1_800_000_000 };
  const envelope = await signActorEnvelope(payload, "shared-secret");
  assert.deepEqual(await verifyActorEnvelope(envelope, "shared-secret", 1_700_000_000_000), payload);
  await assert.rejects(() => verifyActorEnvelope(envelope, "wrong-secret", 1_700_000_000_000), /ACTOR_ENVELOPE_INVALID/);
  await assert.rejects(() => verifyActorEnvelope(envelope, "shared-secret", 1_900_000_000_000), /ACTOR_ENVELOPE_INVALID/);
  assert.match(await subjectHash(payload.subject, "shared-secret"), /^sha256:[a-f0-9]{64}$/);
});
