
# ZXLab

ZXLab is my personal site for projects, technical notes, and experiments.

The main site is built by hand to understand the frontend architecture,
visual system, content pipeline, and deployment process before using agents
to extend it.

## Tech stack

- Astro
- TypeScript
- Native CSS
- Markdown Content Collections
- Static site generation

## Local development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

The production build first compiles the vendored STONKS Vite app from
`apps/stonks/` into `public/lab/stonks/game/`, then builds the Astro site. The
game remains an isolated package and is rendered by the Astro shell at
`/lab/stonks/`.

To refresh the STONKS snapshot, copy the desired upstream revision into
`apps/stonks/` while preserving zxlab's deployment changes in
`apps/stonks/vite.config.ts`, the namespaced autosave key in
`apps/stonks/src/ui/App.tsx`, and the metadata in `apps/stonks/index.html`.
Then run:

```bash
npm install
npm run build:stonks
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Project structure

```text
functions/          Cloudflare Pages Functions for server-side APIs and live status data
services/           Private, separately deployed status collectors
src/
├── components/     Reusable interface components
├── content/        Markdown notes
├── data/           Structured project data
├── lab/            Lab project definitions and lazy experiment modules
├── layouts/        Shared page shells
├── pages/          File-based routes
├── status/         Public status types, providers, and client boundary
└── styles/         Global styles and design tokens
```

Static files that should be copied directly are stored in `public/`. Astro still
builds as a static site; the Function boundary serves sanitized status JSON and
the server-only AI Gateway.

## AI Gateway

Reusable AI features call `generateAI()` or the incremental `streamAI()` from
`src/lib/ai/client.ts`, which send validated requests to `POST /api/ai/generate`
or `POST /api/ai/stream`. Provider URLs, keys, model IDs,
timeouts, retries, fallback routing, and structured-output parsing remain inside
Cloudflare Pages Functions. The fixed model order is Provider 1 GPT-5.6,
Provider 1 GPT-5.5, Provider 2 GPT-5.5, then DeepSeek V4 Pro.

Copy `.dev.vars.example` to the ignored `.dev.vars` file for Pages-local
development. In Cloudflare Pages, add base URLs and model IDs as runtime
variables and add all API keys plus `AI_GATEWAY_ACCESS_TOKEN` as encrypted
secrets. Production fails closed when neither an access token nor a supported
`AI_RATE_LIMITER` binding is present. Do not expose the access token in browser
code; browser-facing features must use the site's authenticated server boundary.

Implementation details, response examples, fallback rules, and local testing are
documented in [`docs/ai-gateway.md`](docs/ai-gateway.md).

## Main routes

* `/` — Homepage
* `/projects` — Project archive
* `/notes` — Notes archive
* `/lab` — Interactive experiment index
* `/lab/[slug]` — Isolated experiment container
* `/lab/strudel` — Embedded Strudel live coding playground
* `/lab/stonks` — Desktop-only fictional market simulation
* `/status` — Public, privacy-filtered status dashboard
* `/about` — About page

Project and note detail pages are generated from shared data and content
collections.

## Publishing notes from Obsidian

Only non-empty notes with `publish: true` in YAML frontmatter are eligible.
Technical notes and journal entries use separate commands:

```bash
npm run notes:publish:technical -- --dry-run
npm run notes:publish:journal -- --dry-run

npm run notes:covers:technical -- --dry-run
npm run notes:covers:journal -- --dry-run
npm run notes:covers:journal

npm run notes:publish:technical
npm run notes:publish:journal
npm run notes:publish:journal -- --accept-covers
```

Remove `--dry-run` only from a clean `beta` worktree. A real publish pulls
`origin/beta` with fast-forward-only semantics, converts the selected category,
validates references and attachments, builds the site, commits generated files,
and pushes the branch. Override the local Vault location with
`OBSIDIAN_VAULT_PATH` when needed.

The minimum source metadata is:

```yaml
---
publish: true
---
```

Optional fields include `title`, `description`, `slug`, `publishedAt`, `tags`,
`aliases`, `cover`, `coverAlt`, and `accent`. Wiki Links become blog URLs when
their target is published; unresolved targets remain visible text and are kept
in the generated relationship graph.

Notes without an explicit `cover` can use the local two-model cover workflow.
The cover commands use `OPENAI_TEXT_*` for the structured visual brief and
`OPENAI_*` for image generation, loading `../.env` only during a real cover
generation run. Generated previews stay in the ignored `.note-cover-cache/`
directory for review. The matching publish command accepts reviewed previews
only when passed `--accept-covers`; the Obsidian vault remains read-only.

## Design

The interface is intentionally restrained, editorial, and content-driven.

See:

* `docs/visual-guidelines.md`
* `docs/lab-status.md`
* `AGENTS.md`

## Status

The first hand-built version is under active development.
