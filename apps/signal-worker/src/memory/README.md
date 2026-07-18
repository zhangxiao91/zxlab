# Unified Memory Backend

This module is the canonical, auditable long-term memory boundary for zxlab. It
runs inside the existing `signal-worker`, uses the existing D1 binding, Access
authentication, environment configuration, and project AI Gateway.

## Layout

```text
memory/
  api/             REST routing
  repository/      D1 persistence and row mapping
  schema/          contracts and request validation
  service/         retrieval, CRUD, revision, and forget semantics
  consolidation/   LLM prompt, validation, candidates, human resolution
```

The legacy `memory_entries` and annotation candidate routes remain available for
briefing UI compatibility. Migration `0003_memory_backend.sql` copies existing
legacy memory into `memory_items`; new code should use this module.

## Data lifecycle

```text
briefing interaction -> feedback_events -> consolidation candidate
                                         -> human accept -> memory_items
                                                          -> memory_revisions on update/forget
```

Feedback never changes `memory_items` directly. Consolidation never auto-accepts
a candidate. Forgetting is a soft state transition and retains audit history.

## REST API

All endpoints are protected by the existing Signal Worker authentication.
Production uses Cloudflare Access; local development uses the bearer token in
`ZX_SIGNAL_WRITE_TOKEN`.

### `POST /api/memory/events`

```json
{
  "targetType": "briefing_item",
  "targetId": "item-id",
  "action": "dislike",
  "comment": "这类纯融资新闻没有产品进展"
}
```

Actions: `like`, `dislike`, `save`, `dismiss`, `comment`.

### `POST /api/memory/retrieve`

```json
{
  "task": "signal-briefing",
  "namespaces": ["briefing", "zxlab", "global"],
  "query": "今天的候选标题与摘要",
  "limit": 12,
  "tokenBudget": 1500
}
```

Returns `{ memories, summary, tokenEstimate }`. Ranking combines namespace
priority, importance, confidence, recency, and lexical overlap. Expired,
superseded, and forgotten items are excluded. The token estimate is deliberately
conservative and does not require another model call.

### `POST /api/memory/items`

```json
{
  "namespace": "briefing",
  "kind": "preference",
  "content": "用户通常不关注纯融资新闻。",
  "importance": 0.7,
  "confidence": 0.75,
  "sourceType": "manual",
  "sourceId": "admin"
}
```

### `PATCH /api/memory/items/:id`

Accepts any editable item fields plus required `reason`. Every update inserts a
`memory_revisions` row before updating the item.

### `POST /api/memory/items/:id/forget`

Body: `{ "reason": "No longer applicable" }`. This sets `status=forgotten`;
it never physically deletes the row.

### Debug and consolidation

- `GET /api/memory/items` returns items, revisions, and consolidation candidates.
- `GET /api/memory/items/:id/revisions` returns one item's revision history.
- `POST /api/memory/consolidate` with `{ "limit": 50 }` analyzes recent events.
- `POST /api/memory/consolidation/candidates/:id/accept` applies a proposal.
- `POST /api/memory/consolidation/candidates/:id/reject` rejects a proposal.

The debug UI is `/admin/memory`. It intentionally exposes no provider keys or
model configuration and performs writes only through the protected API.

## Migrations and sample data

```bash
npm run db:migrate:local --workspace signal-worker
npx wrangler d1 execute zx-signal --local --file apps/signal-worker/seed/memory.sql
```

Apply the production migration through the existing reviewed deployment flow.
The seed is an explicit development example and is not part of the migration.

## Briefing integration

`BriefingGenerator` retrieves `briefing`, `zxlab`, `global`, and `markets`
memory before editorial filtering and synthesis. Memory remains context only:
it cannot create facts or sources. The interaction UI is intentionally unchanged;
clients can send like/dislike/save events to the event endpoint.
