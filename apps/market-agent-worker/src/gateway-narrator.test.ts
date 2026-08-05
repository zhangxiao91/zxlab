import assert from "node:assert/strict";
import test from "node:test";
import { GatewayNarrator } from "./gateway-narrator.ts";
import type { SealedEvidenceBundle } from "@zxlab/market-agent-schema";

const evidence: SealedEvidenceBundle = { schemaVersion: "market-agent.v1", eventRuleVersion: "market-event.v1", profileId: "p1", workflow: "close_review", watchlistRevision: "w1", instrumentIds: [], items: [], contextUses: [], fingerprint: "sha256:g", sealedAt: "2026-08-05T00:00:00.000Z" };
test("gateway narrator sends only the bounded task and sealed evidence", async () => {
  const narrator = new GatewayNarrator({ apiUrl: "https://gateway.example/api/ai/generate", token: "secret", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { task: string; messages: Array<{ content: string }> };
    assert.equal(body.task, "market-agent-close-review"); assert.match(body.messages[1].content, /sha256:g/);
    return new Response(JSON.stringify({ ok: true, data: { json: { status: "success", headline: "ok", summary: "ok", observations: [], portfolioImpacts: [], watchNext: [], limitations: [], evidenceFingerprint: "sha256:g" }, text: "", provider: "fixture", model: "fixture", fallbackIndex: 0, latencyMs: 1 }, requestId: "r1" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await narrator.narrate({ workflow: "close_review", evidence }) as { headline: string };
  assert.equal(result.headline, "ok");
});
