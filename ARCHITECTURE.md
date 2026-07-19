# ZXLab Architecture

ZXLab is a personal monorepo that has grown from a static Astro site into a
small private platform. The repository keeps the public reading surface, lab
experiments, Cloudflare server boundaries, private collectors, and device tools
close together so their contracts can evolve in one place.

## System Shape

```text
Astro static site
  -> Cloudflare Pages Functions
       -> AI provider gateway
       -> status and risk proxy APIs
  -> Cloudflare Workers
       -> Signal briefing and Memory backend
       -> zxtoolkit device, Drop, and Pulse APIs
       -> risk market data worker
  -> private services
       -> Codex usage collector
  -> bundled or separate apps
       -> STONKS Vite game
       -> zxtoolkit Web/PWA and Tauri desktop app
       -> private risk-api FastAPI prototype
```

The public site remains mostly static. Anything that needs credentials,
identity, mutable state, provider fallback, or privacy filtering lives behind a
server boundary.

## Repository Map

```text
src/                  Astro pages, components, content, styles, and browser clients
functions/            Cloudflare Pages Functions for same-origin server APIs
apps/stonks/          Isolated Vite market-simulation game embedded under /lab/stonks
apps/signal-worker/   Cloudflare Worker for briefing generation, annotations, and Memory
apps/zxtoolkit/       Device toolkit: Web/PWA, Worker, shared protocol, Tauri desktop
apps/risk-api/        Private FastAPI prototype for portfolio risk domains
apps/risk-market-worker/
                      Cloudflare Worker market data gateway for risk features
packages/signal-schema/
                      Shared Signal contracts and runtime validation
services/             Private services deployed outside Cloudflare Pages
scripts/              Publishing, cover-generation, verification, and maintenance tools
docs/                 Focused subsystem design notes
public/               Static assets and built lab snapshots
```

## Major Boundaries

### Site Shell

Astro owns routing, layout, editorial pages, notes, project archives, Lab
navigation, Status, and static rendering. Browser code calls server APIs through
small typed clients instead of reading secrets or provider configuration.

The most important public routes are `/`, `/projects`, `/notes`, `/lab`,
`/briefing`, `/status`, and `/about`.

### Cloudflare Pages Functions

`functions/` is the same-origin server boundary for the Astro site. It handles:

- AI generation and streaming via `/api/ai/generate` and `/api/ai/stream`.
- Risk review proxying through `/api/risk/review`.
- Market quotes and bars for browser-facing risk features.
- Public Status APIs that sanitize Tailscale, Codex usage, and LLM telemetry.

Provider URLs, API keys, fallback order, retry decisions, access-token checks,
and structured-output parsing stay here. Browser features receive only validated
results and coarse provider metadata.

### Signal

`apps/signal-worker/` owns the ZX Signal intelligence loop:

```text
collectors -> normalized candidates -> editorial filtering -> AI gateway
  -> D1 briefing versioning -> /briefing UI
  -> annotations -> reply generation -> user-confirmed Memory
```

The Worker persists state in D1 and shares contracts through
`packages/signal-schema`. It does not hold model-provider credentials directly;
it calls the project AI gateway server-to-server with its own encrypted access
token.

### Risk

Risk has two tracks:

- `src/features/risk` and `/lab/risk` provide the browser workbench.
- `apps/risk-api` models a private FastAPI backend with market, ledger, risk
  engine, and read-only review-agent domains.

The current production-facing path favors Cloudflare boundaries: market data and
LLM review are exposed through Pages Functions or Workers, while the browser
submits explicit evidence snapshots instead of credentials or mutable plans.

### zxtoolkit

`apps/zxtoolkit` is a separate device toolkit that includes:

- Web/PWA inbox and pairing screens.
- Tauri 2 macOS menu bar app.
- Cloudflare Worker with device auth, Turnstile checks, rate limits, D1, R2,
  Durable Objects, Drop delivery, and Pulse status snapshots.
- Shared protocol types in `shared/`.

zxtoolkit is deliberately privacy-filtered. Pulse publishes coarse device state
for Status, while Drop handles personal content delivery between paired devices.

### STONKS

`apps/stonks` is an isolated Vite app with its own simulation core, tests, CLI
tuning tools, and React inspection UI. The root build compiles it into
`public/lab/stonks/game/`, and Astro embeds that built snapshot at
`/lab/stonks`.

## Data And Secret Rules

- Secrets must stay in Cloudflare encrypted variables, Worker secrets, ignored
  local env files, Keychain, or private service configuration.
- No provider key, Cloudflare Access token, Tailscale credential, Codex session,
  broker credential, or zxtoolkit device token should enter browser bundles.
- External text, market data, model output, and client-submitted payloads are
  untrusted until normalized and validated at the owning boundary.
- Mutable domain state belongs to D1, R2, Durable Objects, private Postgres, or
  local app storage depending on the subsystem.
- Generated telemetry must avoid prompts, model responses, credentials, and raw
  identity data unless a subsystem document explicitly permits a sanitized field.

## Build And Runtime Model

The root package builds the public site and the embedded STONKS snapshot:

```bash
npm run build
```

Sub-apps keep their own verification commands because they target different
runtimes:

```bash
npm run test:ai
npm run test:risk
npm test --workspace signal-worker
npm run typecheck --workspace zxtoolkit
npm test --workspace stonks-wip
```

Astro can remain static because live or sensitive behavior is pushed to Pages
Functions, Workers, or private services.

## Evolution Pattern

Most features follow the same path:

1. Build a static or mocked UI inside the Astro site or a Lab route.
2. Define explicit TypeScript domain types and browser-safe client contracts.
3. Move secrets, provider calls, state mutation, and access checks behind a
   server boundary.
4. Add runtime validation, fallback behavior, and sanitized error states.
5. Add telemetry or Status integration only after the data is privacy-filtered.

This pattern is visible in Status, Signal, Risk, and zxtoolkit. It is the main
architectural constraint to preserve as the repository grows.

## Subsystem Docs

- [AI Gateway](docs/ai-gateway.md)
- [Lab and Status](docs/lab-status.md)
- [ZX Signal](docs/zx-signal.md)
- [Risk MVP](docs/risk-mvp-architecture.md)
- [zxtoolkit architecture](apps/zxtoolkit/docs/architecture.md)
- [STONKS progress](apps/stonks/docs/PROGRESS.md)
