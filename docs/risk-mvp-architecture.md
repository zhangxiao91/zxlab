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

- `MarketDataProvider` in the private FastAPI prototype remains Mock-first. The production-facing Cloudflare path is `apps/risk-market-worker`: quotes use Tencent, Sina, then Eastmoney fallback; daily and minute bars use independent provider chains. The browser reaches it through same-origin Pages proxies.
- `PortfolioProvider`: manual and CSV now; Wealthfolio, broker CSV, and read-only broker APIs use the same protocol later.
- `ReadOnlyToolRegistry` in FastAPI still exposes typed Mock tools. Separately, `/lab/market` now reads normalized live market news plus per-stock news, and company announcements with CNInfo-first/Eastmoney fallback. Every result retains its source, receive time, warnings, and provider-attempt metadata; partial upstream failure remains visible instead of being replaced with fixture data.

The Cloudflare market gateway is read-only and currently accepts SSE/SZSE six-digit instruments. It exposes `/api/market/quotes`, `/api/market/bars/:instrument`, `/api/market/news`, `/api/market/announcements`, `/api/market/status`, and `/api/market/providers`. Exchange status is a weekday/session approximation and is explicitly marked as lacking a holiday calendar.

## Explicit non-goals

No order creation, cancellation, automatic stop loss, brokerage credential handling, high-frequency storage, multi-user permissions, or LLM mutation of plans and rules exists in the MVP.
