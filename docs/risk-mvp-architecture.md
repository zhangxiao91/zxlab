# 个人持仓风险台 MVP 架构

## Dependency boundary

```text
Astro / React UI
       |
   FastAPI routes
   /    |     |    \
Market Ledger Risk Review
Gateway       Engine Agent
```

The four domain packages do not import each other's database models. `Risk Engine` accepts explicit Pydantic snapshots. `Review Agent` accepts an `EvidencePack` and only exposes read-only tools. Repository adapters will translate SQLAlchemy records into domain models.

## Data lineage

Every market value retains market time, receive time, source, quality, adjustment basis, and warnings. Risk events retain rule ID, actual value, threshold, trigger time, evidence IDs, and data warnings. Stale data produces `effective_exposure = null`; an indicative stale number may be displayed only with an explicit unreliable label.

Transactions are append-only. Corrections use a new adjustment or correction event. Trade plans preserve version history. External text is untrusted and cannot alter the Review Agent's instructions.

## Provider seams

- `MarketDataProvider`: Mock now; mootdx and Tencent adapters are reserved behind the same protocol.
- `PortfolioProvider`: manual and CSV now; Wealthfolio, broker CSV, and read-only broker APIs use the same protocol later.
- `ReadOnlyToolRegistry`: announcements, news, and industry performance are registered now as typed Mock tools.

## Explicit non-goals

No order creation, cancellation, automatic stop loss, brokerage credential handling, high-frequency storage, multi-user permissions, or LLM mutation of plans and rules exists in the MVP.
