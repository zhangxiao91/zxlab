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
       -> Runtime status control plane and incident history
       -> Signal briefing and Memory backend
       -> zxtoolkit device, Drop, and Pulse APIs
       -> risk market data worker
  -> private services
       -> Codex usage collector
  -> bundled or separate apps
       -> STONKS Vite game
       -> Yuzi Vite game and Durable Object API
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
apps/yuzi/           Git submodule pinning the independent Yuzi game and Worker
apps/runtime-worker/  Runtime probes, public Status aggregation, and private Ops API
apps/signal-worker/   Cloudflare Worker for briefing generation, annotations, and Memory
apps/zxtoolkit/       Device toolkit: Web/PWA, Worker, shared protocol, Tauri desktop
apps/risk-api/        Private FastAPI prototype for portfolio risk domains
apps/risk-market-worker/
                      Cloudflare Worker market data gateway for risk features
packages/signal-schema/
                      Shared Signal contracts and runtime validation
packages/runtime-schema/
                      Browser-safe Runtime and Status contracts
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
- Compatibility Status routes and protected Pages health/usage adapters.

Provider URLs, API keys, fallback order, retry decisions, access-token checks,
and structured-output parsing stay here. Browser features receive only validated
results and coarse provider metadata. Pages does not aggregate Status state;
that responsibility belongs to Runtime.

The AI gateway exposes one deep module interface to callers and keeps a fixed
provider policy behind it: official DeepSeek V4 Flash is primary, official Kimi
K3 is the only fallback, and both share the OpenAI-compatible Chat Completions
adapter. Callers cannot select providers or models.

### Runtime

`apps/runtime-worker/` is the control plane for public Status and private
operations. A scheduled probe run calls protected health endpoints on Pages,
Signal, zxtoolkit, and the risk market Worker through service bindings where
possible. It stores normalized samples, probe runs, activities, and incidents
in its own `zx-runtime` D1 database.

Runtime exposes two API surfaces:

- `/api/v1/public/status` returns only coarse Runtime, Memory, Agents, and Usage
  modules. A missing or stale source remains unavailable.
- `/api/v1/private/*` requires Cloudflare Access and powers `/admin/ops`, manual
  probes, incident inspection, and the Memory management proxy.

Runtime never owns Memory content. Private Memory calls are authenticated at
Runtime and forwarded to Signal, which remains the source of truth.

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

`memory_items` is the canonical Memory table. Annotation responses, briefing
generation, consolidation, and Ops all read or write through the unified Memory
repository. Legacy Memory tables are retained read-only for rollback and audit;
normal application paths must not write to them.

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

### Yuzi

`apps/yuzi` is a git submodule that pins the public Yuzi repository. The root
build writes its Vite snapshot to `public/lab/yuzi/game/`, and the Astro shell
at `/lab/yuzi` embeds that static app from the same origin.

The browser holds only a short bearer session token and local completed
residuals. `yuzi-api.zx-dx.xyz` owns Turnstile verification, IP/session rate
limits, the five-turn Durable Object state machine, and output validation. It
calls the Pages AI Gateway with the server-only `yuzi-turn` task token; model
credentials and the gateway access token never enter the game bundle. Yuzi's
model generates bounded narrative text and candidates, while its deterministic
domain layer owns phrase erasure, state invariants, and final judgment.

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
- `ZX_RUNTIME_SERVICE_TOKEN` is shared only between Runtime and protected health
  adapters. Cloudflare Access credentials protect the separate private Ops API.

## Build And Runtime Model

The root package builds the public site and both embedded game snapshots:

```bash
npm run build
```

Sub-apps keep their own verification commands because they target different
runtimes:

```bash
npm run test:ai
npm run test:risk
npm test --workspace runtime-worker
npm test --workspace signal-worker
npm run typecheck --workspace zxtoolkit
npm test --workspace stonks-wip
```

Astro can remain static because live or sensitive behavior is pushed to Pages
Functions, Workers, or private services.

## Evolution Pattern

Most features follow the same path:

1. Define the user-facing surface and its unavailable state inside Astro.
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
- [Personal Market Agent plan](docs/market-agent-plan.md)
- [zxtoolkit architecture](apps/zxtoolkit/docs/architecture.md)
- [STONKS progress](apps/stonks/docs/PROGRESS.md)
