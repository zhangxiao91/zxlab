# Market Agent beta acceptance

Market Agent generation is routed through the unified Gateway with this order:

1. DeepSeek official;
2. the Market Agent fast OpenAI fallback, when configured;
3. the configured OpenAI text model;
4. the remaining Gateway candidates.

Beta is isolated from Production at the Worker state boundary:

- Pages Preview binds `MARKET_AGENT_SERVICE` to `zxlab-market-agent-beta`;
- Pages Production remains bound to `zxlab-market-agent`;
- the beta Worker owns `market-agent-beta`, `market-agent-runs-beta`, and
  `market-agent-runs-beta-dlq`;
- beta has no cron trigger; acceptance Runs are created explicitly;
- only the beta Worker points to
  `https://beta.zxlab.pages.dev/api/ai/generate`.

Run the environment gate after the beta Pages deployment and beta Worker deploy:

```bash
npm run verify:market-agent:env -- --commit "$(git rev-parse HEAD)"
```

It verifies the Preview Gateway credentials by binding type, the successful beta
commit, the isolated Preview/Production service bindings, and the beta Worker's
Gateway URL/token. Secret values are never included in the report. A stale
Preview `DEEPSEEK_*_MODEL` override is reported as a warning and should be
removed unless it is intentionally part of the current Gateway contract.

Then run one dedicated end-to-end request:

```bash
npm run verify:market-agent:run
```

The command creates and polls three independent `close_review` Runs through the
Keychain-backed debug Access path. Every Run must pass; use `--runs 1` only for
fast diagnosis. Acceptance allows `success` or an evidence-limited `partial`
Run, but each Run requires a completed model narration with
`provider=deepseek`, a DeepSeek model, `fallbackIndex=0`, and a Gateway request
ID. A deterministic narration or any provider fallback fails the command.
