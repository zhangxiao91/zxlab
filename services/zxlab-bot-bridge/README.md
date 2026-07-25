# zxlab Bot Bridge

Private MCP tools for the Memoh `wechat-assistant` bot.

The bridge keeps provider credentials and canonical-memory credentials outside
the Memoh Workspace. Ordinary conversation still uses Memoh's own model.
Complex Signal/Risk tasks can explicitly call the ZXLab AI Gateway.

Tools:

- `signal_latest`: latest published ZX Signal briefing.
- `zxlab_ai_task`: stream-first structured Signal/Risk generation through
  `/api/ai/stream`, with `/api/ai/generate` only as a transport/protocol
  fallback.
- `market_status` and `market_quotes`: normalized market data including source,
  timestamp, quality and freshness.
- `risk_snapshot`: deterministic read-only exposure, concentration and drawdown
  review from user-supplied positions. It never connects to a broker.
- `risk_review`: the same snapshot plus an evidence-bound Gateway explanation.
- `canonical_memory_search`: confirmed long-term ZXLab memory retrieval.
- `canonical_memory_save_confirmed`: canonical API write, available only after
  explicit confirmation of the exact content.

The service runs on the same private Docker network as Memoh and does not
publish a host port.

## Server-side environment

```env
BRIDGE_AUTH_TOKEN=
SIGNAL_API_BASE_URL=https://signal-api.zx-dx.xyz
AI_GATEWAY_BASE_URL=https://beta.zxlab.pages.dev
AI_GATEWAY_ACCESS_TOKEN=
MARKET_API_BASE_URL=https://beta.zxlab.pages.dev
CANONICAL_MEMORY_API_BASE_URL=https://signal-api.zx-dx.xyz
CANONICAL_MEMORY_API_TOKEN=
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=
```

`AI_GATEWAY_ACCESS_TOKEN`, the Memory bearer token, and Cloudflare Access
service-token fields belong only in the bridge's mode `0600` environment file.
They must not be copied into Memoh Workspace files, prompts, or chat memory.

## Local verification

```bash
npm install
npm run typecheck
npm test
npm run build
BRIDGE_PORT=8789 npm start
```

MCP endpoint: `http://127.0.0.1:8789/mcp`.

## Remote deployment

Copy this directory to `/home/ubuntu/zxlab/zxlab-bot-bridge`, create a mode
`0600` `.env`, and run `docker compose up -d --build`. The Memoh MCP connection
should use `http://zxlab-bot-bridge:8789/mcp` from the `memoh_internal_v016`
network. If `BRIDGE_AUTH_TOKEN` is set, configure the same Bearer token in the
Memoh MCP connection headers.

`canonical_memory_save_confirmed` is the only mutating tool. Configure Memoh to
require approval for it. It calls the canonical API and never writes D1
directly. Do not put Cloudflare Access cookies, AI Gateway tokens, or other
long-lived credentials in the Memoh Workspace.
