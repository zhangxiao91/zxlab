# Codex usage collector

This small Node service keeps one authenticated `codex app-server` child
process behind a private HTTP boundary. It returns only normalized rate-limit
and Token totals. Account identity and Codex credentials never enter its HTTP
response.

Copy this directory from the blog workspace, then run it as the same
operating-system user whose Codex CLI is already logged in:

```bash
rsync -av services/codex-usage-collector/ <ssh-host>:~/zxlab-codex-usage/
ssh <ssh-host>
command -v codex
cd ~/zxlab-codex-usage
npm test
```

Install the user service after replacing the example values:

```bash
mkdir -p ~/.config/systemd/user
cp codex-usage-collector.env.example ~/.config/zxlab-codex-usage.env
cp codex-usage-collector.service.example ~/.config/systemd/user/zxlab-codex-usage.service
systemctl --user daemon-reload
systemctl --user enable --now zxlab-codex-usage
```

Set `CODEX_BIN` to the absolute path returned by an interactive
`command -v codex`. Protect `/v1/usage` with a long random
`STATUS_API_TOKEN`. The service binds to `127.0.0.1` by default; expose it only
through an HTTPS reverse proxy or private tunnel. `Caddyfile.example` shows the
smallest TLS proxy. Restrict inbound access at the firewall to the proxy or
trusted origin where practical.

Verification and operations:

```bash
curl http://127.0.0.1:8788/health
curl -H "Authorization: Bearer $STATUS_API_TOKEN" http://127.0.0.1:8788/v1/usage
systemctl --user status zxlab-codex-usage
journalctl --user -u zxlab-codex-usage -f
systemctl --user restart zxlab-codex-usage
npm test
```

`/health` exposes only the collector version, coarse App Server state, and the
last successful collection time. It never includes account or Usage data.
