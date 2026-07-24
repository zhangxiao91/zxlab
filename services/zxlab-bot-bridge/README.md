# zxlab Bot Bridge

Private read-only MCP tools for the Memoh `wechat-assistant` bot.

The first tool is `signal_latest`, which reads the published ZX Signal
briefing from `signal-api.zx-dx.xyz` and formats it for a private chat. The
service is intended to run on the same private Docker network as Memoh and
does not publish a host port.

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

Only read-only tools belong in the first deployment. Do not put Cloudflare
Access cookies, AI Gateway tokens, or other long-lived credentials in the
Memoh Workspace.
