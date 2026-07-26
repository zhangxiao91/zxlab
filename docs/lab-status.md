# Lab and Status development

Lab and Status extend the existing Astro site without introducing a backend or
shipping experiment code to unrelated pages. Both sections use the shared
Layout, navigation, footer, typography, colors, and motion conventions.

## Adding a Lab project

1. Add one typed definition to `src/lab/projects.ts`. Keep unavailable work
   explicitly marked `coming-soon`; do not imply that a placeholder is usable.
2. Use the project slug for its generated `/lab/[slug]` route.
3. When an experiment becomes runnable, add a matching
   `src/lab/experiments/<slug>.ts` module, set the project status to `beta` or
   `available`, and set `clientEntry` to the module key.

Optional source, documentation, or related-project links belong in the
project's `links` array and render beside its instructions only when present.

Experiment modules implement the `ExperimentModule` contract from
`src/lab/types.ts`:

```ts
export async function mount(root, context) {
  // Create the experiment inside root and honor context.signal.
  return () => {
    // Remove listeners and release experiment resources.
  };
}
```

The detail-page frame lazy-loads this module with `import.meta.glob`. The module
is therefore split away from the site shell and other routes. Throwing during
load or mount is caught by the frame and shown as a local error state. Future
experiments should provide keyboard operation, touch fallbacks, reduced-motion
behavior, and their own cleanup function.

## Strudel Playground

`/lab/strudel` is a custom Lab route that lazy-loads the official
`@strudel/repl` Web Component rather than mounting a generic experiment module.
The preset sources live in `src/lab/strudel/preset.ts`; the UTF-8 Base64
long-URL encoder lives in `src/lab/strudel/embed.ts`. This follows
[Strudel's documented long URL format](https://strudel.cc/technical-manual/project-start/)
and avoids temporary database-backed share IDs.

Audio begins only after the visitor interacts with the editor and runs the
pattern. The same-origin runtime exposes the shared `superdough` master output,
which is connected in parallel to an `AnalyserNode` for the live spectrum. The
analyser does not alter the destination signal and does not request microphone
or capture permissions. Reset, preset changes, `pagehide`, and
`astro:before-swap` explicitly stop the active pattern.

The runtime is route-local and dynamically imported, so other pages do not
download the editor bundle. A deployment Content Security Policy must permit
the runtime's WebAudio worklets and evaluated live-coding source.

Run `npm run verify:strudel` to verify that the preset survives URL encoding
and still contains the required tempo, drum, bass, filter, delay, and reverb
parts. Dependency upgrades must keep `@strudel/repl` and `@strudel/webaudio`
on compatible versions so the editor and analyser share one audio controller.

The frame's loading and fallback surfaces can be checked with
`?experiment-state=loading|error|unsupported|unavailable` on any Lab detail
route. This query changes only the local frame preview.

## Status data boundary

Status is a browser client of the independent Runtime Worker. Production has no
local fallback dataset. The page fetches one normalized snapshot from:

```text
GET https://runtime-api.zx-dx.xyz/api/v1/public/status
```

Set `PUBLIC_RUNTIME_API_BASE` only when a deployment uses a different Runtime
origin. Local Astro development defaults to `http://localhost:8790`; when that
Worker is not running, every module renders an explicit unavailable state.
Compatibility Pages routes under `/api/status`, `/api/status/devices`, and
`/api/status/usage` proxy Runtime and do not aggregate data themselves.

Runtime probes these protected adapters once per minute:

- Pages: `/api/runtime/health` and `/api/runtime/usage`.
- Signal: `/internal/runtime/health` through the `SIGNAL` service binding.
- zxtoolkit: `/internal/runtime/health` through the `ZXTOOLKIT` service binding.
- Risk market: `/internal/runtime/health` through the `MARKET` service binding.

All adapters require the same encrypted `ZX_RUNTIME_SERVICE_TOKEN`. The token
must never have a `PUBLIC_` prefix or enter an Astro browser bundle. Runtime
stores probe samples and incident history in `zx-runtime` D1, marks snapshots
stale after three minutes, opens incidents after two consecutive failures, and
resolves them after two consecutive successes.

The four public modules are Runtime, Memory, Agents, and Usage. Module failures
are independent: one unavailable source cannot erase valid data from the other
modules. Runtime responses contain allowlisted aliases and coarse counts only.

## Private operations

`/admin/ops` calls `/api/v1/private/*` directly on Runtime with Cloudflare
Access cookies. It supports service and incident inspection, manual probes,
Memory create/edit/forget, candidate review, consolidation, and revision
history. Deployment controls are intentionally absent.

Memory content remains in Signal D1. `memory_items` is the canonical table and
all normal readers and writers use the unified repository. Migration `0005`
idempotently backfills legacy entries and candidates; old tables remain
read-only during the rollback window.

For rollout, export the Signal D1 database before applying `0005`, then migrate
`zx-runtime` and deploy in this order: Signal, zxtoolkit, risk market, Runtime,
Pages. Rollback restores the previous Worker versions and keeps the legacy
tables intact; do not reverse-delete the unified tables until the retained data
has been audited.

## Public privacy contract

Client-facing device data is deliberately limited to a generated public ID,
public name, device type, coarse state, last-seen time, optional coarse latency,
optional public task, and update time. IP addresses, private overlay-network addresses, SSH details,
serial numbers, precise location, credentials, and network topology must remain
server-side and must never be added to `DeviceStatus`.
