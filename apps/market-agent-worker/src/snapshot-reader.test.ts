import assert from "node:assert/strict";
import test from "node:test";
import type { MarketSnapshot } from "@zxlab/market-schema";
import { MarketSnapshotAdapter } from "./snapshot-reader.ts";

const snapshot: MarketSnapshot = {
  schemaVersion: "market-snapshot.v1",
  asOf: "2026-08-07T08:00:00.000Z",
  receivedAt: "2026-08-07T08:00:01.000Z",
  marketTimestamp: "2026-08-07T08:00:00.000Z",
  request: { instrumentIds: ["SSE:600000"], intervals: ["1d"], include: ["quotes"], quoteMode: "corroborated" },
  data: { quotes: [], bars: [], news: [], announcements: [], status: [] },
  capabilities: [{ id: "quotes", status: "operational", required: true, asOf: "2026-08-07T08:00:00.000Z", receivedAt: "2026-08-07T08:00:01.000Z", freshness: "fresh", warnings: [], attempts: [] }],
  quality: { status: "operational", reliable: true, freshness: "fresh", warnings: [], attempts: [], unavailableCapabilities: [] },
};

test("snapshot adapter sends the fixed scope and validates a data envelope", async () => {
  let captured: Request | undefined;
  const adapter = new MarketSnapshotAdapter({
    baseUrl: "https://market.example",
    token: "worker-token",
    service: {
      async fetch(request: Request) {
        captured = request;
        return Response.json({ data: snapshot });
      },
    } as unknown as Fetcher,
  });

  const result = await adapter.getCurrentSnapshot(snapshot.request);

  assert.equal(result.quality.freshness, "fresh");
  assert.equal(captured?.headers.get("authorization"), "Bearer worker-token");
  assert.equal(captured?.url, "https://market.example/api/market/snapshot?ids=SSE%3A600000&include=quotes&intervals=1d&quoteMode=corroborated");
});

test("snapshot adapter bounds an unresponsive market read", async () => {
  const adapter = new MarketSnapshotAdapter({
    baseUrl: "https://market.example",
    timeoutMs: 5,
    service: {
      fetch(request: Request) {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      },
    } as unknown as Fetcher,
  });

  await assert.rejects(adapter.getCurrentSnapshot(snapshot.request), /MARKET_SNAPSHOT_TIMEOUT/);
});
