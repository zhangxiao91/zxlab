# Context Map

## Contexts

- [Personal Market Agent](./docs/market-agent/CONTEXT.md) — turns normalized market facts, Risk impact, and confirmed personal context into private evidence-bound observations and review runs.
- [Market](./apps/risk-market-worker/src/index.ts) — owns provider adapters, current normalized market facts, capability quality, and fallback behavior.
- [Risk](./docs/risk-mvp-architecture.md) — owns the local ledger, deterministic portfolio replay, risk rules, and portfolio evidence.
- [Signal](./docs/zx-signal.md) — owns canonical durable Memory and its candidate/review lifecycle.
- [AI Gateway](./docs/ai-gateway.md) — owns model policy, routing, fallback, protocol handling, and usage telemetry.

## Relationships

- **Personal Market Agent -> Market**: consumes the current normalized Market Snapshot and provider-quality metadata. Market owns acquisition; the Agent owns only the frozen copy attached to a Run and its derived Market Events.
- **Personal Market Agent -> Risk**: consumes a versioned Portfolio Snapshot and deterministic Risk impact; it does not own the transaction ledger.
- **Personal Market Agent -> Signal**: reads Confirmed Context and proposes candidates; Signal remains the canonical owner of durable Memory.
- **Personal Market Agent -> AI Gateway**: submits sealed Evidence Bundles for bounded narration; the Gateway remains the owner of model selection, retries, fallback, and usage telemetry.
