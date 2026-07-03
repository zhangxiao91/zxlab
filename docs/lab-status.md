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

The frame's loading and fallback surfaces can be checked with
`?experiment-state=loading|error|unsupported|unavailable` on any Lab detail
route. This query changes only the local frame preview.

## Status data boundary

Status uses `StatusSnapshot` and independent `ModuleResult` values for usage,
devices, and activity. One failed source must not remove successfully loaded
modules. The static site defaults to the visibly labeled Mock provider.

The current configuration keys are:

- `PUBLIC_STATUS_PROVIDER=mock|remote`
- `PUBLIC_STATUS_API_BASE_URL=https://public-status.example`

Remote mode is selected only when both a remote provider and a public API base
URL are configured. The reserved endpoints are `/api/status`,
`/api/status/usage`, `/api/status/devices`, and `/api/status/activity`. They are
interfaces for a future filtered service; this repository does not create
those API routes.

Manual display scenarios are available at:

- `/status?status-state=loading`
- `/status?status-state=empty`
- `/status?status-state=error`
- `/status?status-state=unavailable`
- `/status?status-state=stale`
- `/status?status-state=partial`

Polling is disabled by default. If a refresh interval is enabled later, the
client scheduler pauses while the page is hidden and resumes only after it is
visible again.

## Public privacy contract

Client-facing device data is deliberately limited to a public name, device
type, coarse state, last-seen time, optional demo latency, optional public task,
and update time. IP addresses, private overlay-network addresses, SSH details,
serial numbers, precise location, credentials, and network topology must remain
server-side and must never be added to `DeviceStatus`.
