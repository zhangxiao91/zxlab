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

The current public configuration keys are:

- `PUBLIC_STATUS_PROVIDER=mock|tailscale|remote`
- `PUBLIC_STATUS_API_BASE_URL=https://public-status.example`
- `PUBLIC_STATUS_REFRESH_MS=120000`

`tailscale` uses the same-origin `/api/status/devices` endpoint by default, so
`PUBLIC_STATUS_API_BASE_URL` can be omitted. A custom base URL is only needed
when the public gateway is deployed on another origin and permits the site
origin through CORS. Full `remote` mode uses
the reserved endpoints `/api/status`,
`/api/status/usage`, `/api/status/devices`, and `/api/status/activity`.
The Codex usage and Tailscale device routes are implemented; overall and
activity remain reserved interfaces.

## Connecting Codex Usage

The Usage path has three deliberate boundaries:

```text
codex app-server (remote stdio JSON-RPC)
  -> services/codex-usage-collector (private HTTPS JSON)
  -> functions/api/status/usage (sanitized Cloudflare proxy)
  -> Status page
```

The remote collector must run as the same OS user who is already logged into
Codex. It initializes one persistent App Server, calls
`account/rateLimits/read` and `account/usage/read`, then normalizes the result.
The method contract follows the current
[Codex App Server documentation](https://developers.openai.com/codex/app-server/).
The current App Server returns primary and secondary percentage windows plus a
summary and sparse daily Token buckets. Window labels, reset ISO timestamps,
the current-day total, sorting, chart ranges, and heatmap intensity levels are
computed by ZXLab. Missing days remain missing rather than being invented as
zero.

Deploy the files in `services/codex-usage-collector` to the remote host by
following its README. Do not run it as a different user or copy the Codex login
directory. Then configure these Cloudflare Pages server variables:

- `CODEX_USAGE_API_URL`: HTTPS origin of the private collector.
- `CODEX_USAGE_API_TOKEN`: encrypted Bearer secret shared with the collector.
- `CODEX_USAGE_CACHE_TTL`: fresh proxy cache in seconds; default `120`.
- `CODEX_USAGE_STALE_TTL`: last-known-good cache in seconds; default `21600`.
- `CODEX_USAGE_REQUEST_TIMEOUT`: upstream timeout in seconds; default `8`.

None of these names may use a `PUBLIC_` prefix. The browser requests only the
same-origin `/api/status/usage` route and cannot see the Bearer token. The
collector caches App Server reads, and the Pages Function adds a second short
cache. If refresh fails, the Function returns the last successful response as
`stale`; without a cache it returns a sanitized unavailable state while other
Status modules continue rendering.

For local design work, keep `PUBLIC_STATUS_PROVIDER=mock`. To test the real
chain, use Cloudflare Pages local development with uncommitted `.dev.vars`, set
`PUBLIC_STATUS_PROVIDER=tailscale`, and request both `/api/status/usage` and
`/api/status/usage/health`. Run `npm run verify:status` and
`npm run test:collector` before the production build.

Troubleshooting starts at the remote `/health` route, then an authenticated
`/v1/usage` request, then the Pages Function. `CODEX_NOT_LOGGED_IN` means the
service user lacks the existing Codex session; `METHOD_UNSUPPORTED` means the
installed Codex version does not expose one of the methods; timeout and schema
errors are returned without raw App Server payloads. Update Codex and rerun the
collector tests before changing the frontend contract.

## Connecting Tailscale devices

The Tailscale integration keeps Astro static. A Cloudflare Pages Function at
`functions/api/status/devices.ts` obtains a short-lived OAuth token, reads the
tailnet device list, applies a strict allowlist, and returns only the public
`DeviceStatus` shape. The function never returns device IDs, hostnames,
addresses, users, tags, keys, operating-system details, or network topology.

Create a Tailscale OAuth client with only the `devices:core:read` scope. Then
configure these Cloudflare Pages runtime variables and secrets:

- `TAILSCALE_OAUTH_CLIENT_ID`: OAuth client ID; keep server-side.
- `TAILSCALE_OAUTH_CLIENT_SECRET`: encrypted secret.
- `TAILSCALE_TAILNET`: tailnet ID, or `-` to infer it from the credential.
- `TAILSCALE_PUBLIC_DEVICES`: encrypted JSON allowlist and alias map.

`TAILSCALE_PUBLIC_DEVICES` is keyed by a private Tailscale device ID, hostname,
or full device name. Device ID is the most stable choice. Keys are used only
inside the Function; the response contains the configured public alias:

```json
{
  "private-device-id": {
    "id": "studio-workstation",
    "name": "Studio workstation",
    "type": "desktop",
    "publicTask": "Local development"
  },
  "another-private-device-id": {
    "id": "travel-laptop",
    "name": "Travel laptop",
    "type": "laptop"
  }
}
```

Finally, set the build-time variable `PUBLIC_STATUS_PROVIDER=tailscale` and
redeploy the Pages project. Do not prefix any Tailscale credential with
`PUBLIC_`. If credentials or the allowlist are missing, the endpoint returns a
sanitized unavailable response and the Status page keeps rendering its SSR
fallback.

The Function maps Tailscale `connectedToControl` to `online` or `offline` and
uses `lastSeen` only for disconnected devices. It deliberately omits latency;
latency would require an active probe from a trusted tailnet node rather than
the management API.

For local UI work, leave the provider in Mock mode and run `npm run dev`. To
exercise the real Pages Function locally, build the site and run Cloudflare's
Pages development server with local `.dev.vars`; `.dev.vars` files are ignored
by Git and must never be committed.

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

Client-facing device data is deliberately limited to a generated public ID,
public name, device type, coarse state, last-seen time, optional demo latency,
optional public task,
and update time. IP addresses, private overlay-network addresses, SSH details,
serial numbers, precise location, credentials, and network topology must remain
server-side and must never be added to `DeviceStatus`.
