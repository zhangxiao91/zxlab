# Market Snapshot Migration Order

Phase 0 establishes `packages/market-schema` and `GET /api/market/snapshot` as the current-market seam. Provider parsers, upstream URLs, fallback order, corroboration thresholds, caching and calendar adapters remain private to `apps/risk-market-worker`.

## Contract

- Browser-safe schema: `packages/market-schema/src/index.ts`.
- Runtime validation: `validateMarketSnapshot` and `parseMarketSnapshot`.
- Production reader: `apps/risk-market-worker/src/snapshot.ts`.
- Same-origin route: `/api/market/snapshot?ids=...&include=...&intervals=...&quoteMode=fallback|corroborated`.
- `fallback` never claims cross-source validation.
- `corroborated` requires two independent successful sources; one source produces `limited`, and a deviation above 50 bps produces `conflicted`.
- Calendar results outside the official fixture coverage remain `unknown`, with `open: null` and `reliable: false`.

## Consumer order

1. Market Center keeps its current capability calls during Phase 0 but consumes the shared fact/status types and exposes `MarketClient.getSnapshot`. Migrate its refresh transaction to one fallback Snapshot after production soak confirms response size and latency.
2. Risk migrates quotes, daily bars and exchange status together to one fallback Snapshot. Risk calculations must treat `conflicted` as unavailable evidence and must not reinterpret provider attempts.
3. The bot bridge migrates `market_quotes`, `market_status` and `risk_snapshot` reads to the shared validator. Price-bearing agent workflows request `corroborated`; read-only display tools may request `fallback`.
4. Market Agent uses only the Snapshot route through a service-binding adapter and persists an immutable copy per Run. It never calls provider-specific routes or parses provider payloads.

The legacy capability routes remain available during migration. They are compatibility adapters, not a second source of Market Snapshot semantics.
