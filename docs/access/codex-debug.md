# Codex Debug Access

ZXLab has two supported paths for Codex web debugging:

1. Interactive visual debugging uses the Chrome extension with a dedicated
   Chrome profile that has already completed the human Cloudflare Access login.
   This is the preferred path for browser rendering, DevTools, and form flows.
2. Headless browser, HTTP, or API checks use a Cloudflare Access Service Token
   for one machine and one non-production Access application. They never reuse
   a human `CF_Authorization` cookie.

## Runtime Contract

Pages verifies the Cloudflare Access assertion, resolves a small actor context,
and forwards a short-lived signed envelope to the Market Agent Worker. The
Worker verifies all of the following before it resolves a profile:

- the Pages-to-Worker transport secret;
- the envelope signature and 60-second lifetime;
- the HTTP method, path, query, and body digest bound into the envelope;
- the actor's `market-agent:read` or `market-agent:write` scope.

Human actors own the profile identified by their Access `sub`. Registered
machine actors are delegated to an explicit `ownerSubject`; email is never used
as a data owner key or sent to the Worker.

The human Access audience remains `RISK_ACCESS_AUD`. If the debug hostname uses a
separate Access application, put its audience tag in the Pages secret
`ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS` as a JSON array. This allowlist is applied
only to the private proxy; each additional audience is treated as machine-only,
and it does not widen the Risk Review endpoints.

## Pages Secret

Set `ZX_ACCESS_SERVICE_ACTORS` as a Pages secret. It is JSON, not a service
credential:

```json
[
  {
    "clientId": "cloudflare-access-service-client-id",
    "actorId": "codex-side-debug-mac",
    "ownerSubject": "access-subject-for-a-dedicated-debug-account",
    "scopes": ["market-agent:read", "market-agent:write"]
  }
]
```

If an existing deployment already owns the encrypted
`ZX_ACCESS_SERVICE_ACTORS` value, add a separately managed machine through
`ZX_ACCESS_ADDITIONAL_SERVICE_ACTORS` instead of replacing it. Both arrays are
merged, and a duplicate `clientId` fails closed.

Use a separate debug account and profile for machine-driven beta checks. Do not
delegate a headless token to the production owner subject. Remove one entry to
revoke that machine without affecting other Agents.

`MARKET_AGENT_PROXY_TOKEN` remains an internal Pages-to-Worker secret. Set the
same value in Pages and the Market Agent Worker, but never provide it to Codex,
Chrome, Playwright, or an MCP prompt.

## Cloudflare Console Work

1. Add an OIDC, social, or enterprise identity provider that supports passkeys.
   Keep email one-time PIN as a recovery method rather than the normal login.
2. Put normal beta/private UI paths behind one human Access application with a
   practical session duration. Keep `/admin` and Memory-write paths in a
   separate, shorter-session application and add a managed-device/WARP posture
   requirement there.
3. Create a separate `debug-beta` hostname or path for headless automation.
   Its Access policy should allow only its dedicated Service Token and only the
   beta deployment. If it is a separate Access application, add its audience tag
   to `ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS`. Do not add that token to a production
   Admin application.
4. Create one Service Token per headless Codex machine. Register its Client ID
   in `ZX_ACCESS_SERVICE_ACTORS` as `clientId`; Cloudflare includes this value
   in the signed Access JWT `common_name` claim, while a Service Token's `sub`
   is empty. Do not map by email or use the client secret as an application
   identity. Cloudflare's service-token request uses the
   `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers; keep both
   values outside the repository.
5. In the Side Codex client, enable the Chrome plugin and use a dedicated
   `ZXLab Debug - Side` Chrome profile. Sign in once through the passkey-backed
   identity provider, then use `@Chrome` for interactive debugging. The built-in
   Browser uses a separate profile and will not automatically inherit this
   session.

## Cross-session CLI access

New Codex sessions do not automatically inherit a browser cookie or a Cloudflare
Access Service Token. Headless/API checks use the signed native helper described
in [Local Cloudflare Access Credential Proxy](./local-credential-proxy.md). The
helper stores the dedicated debug token in Keychain under account `codex` using
these fixed service names:

- `zxlab.debug-access.proxy.client-id`
- `zxlab.debug-access.proxy.client-secret`

The earlier `zxlab.debug-access.client-id` and
`zxlab.debug-access.client-secret` items are retained only as migration sources.
Install and migrate once from an interactive Terminal; never paste either value
into a Codex prompt or commit it to the repository:

```bash
npm run access:debug:setup
npm run access:debug
```

The Node wrapper uses `launchctl asuser` to start the native helper inside the
current macOS login session. The helper owns the Keychain read and HTTPS request,
fixes the destination to `https://debug-beta.zxlab.pages.dev`, accepts only
enumerated operations, does not follow redirects, and returns only a bounded
summary. It never returns either credential or a raw private response body to
Node or Codex. Interactive rendering remains a separate flow through the
dedicated `@Chrome` profile.

Within Codex managed shell execution, run `npm run access:debug` through its
approved sandbox-external command rule. The restricted sandbox itself cannot
access the login Keychain; ordinary interactive Terminal use does not need this
extra execution boundary.

## Verification

After deployment, verify these cases against beta:

1. A signed-in Chrome profile reaches the private page and retains its normal
   Access session.
2. A valid debug Service Token can reach only the intended debug route and has
   only its configured scope.
3. An unregistered Service Token is denied with
   `ACCESS_SERVICE_ACTOR_UNREGISTERED`.
4. A read-only machine actor receives `403 ACCESS_SCOPE_REQUIRED` on a write.
5. Revoking the Service Token in Cloudflare or removing its secret-map entry
   immediately prevents future requests.

## Deployed State

The persistent Codex debug path was implemented and accepted on 2026-08-11.
This section is the durable handoff for future Codex sessions; it records only
non-secret state.

- Implementation commit: `ecfebf79 feat(access): enable persistent codex debug identity`.
- Native proxy commit: `0ca6d48 feat(access): add native credential proxy`.
- The implementation commit is present on `beta`.
- The isolated Pages deployment is maintained on the remote `debug-beta`
  branch. The accepted deployment was `debug-beta@833dd191`.
- The Access application covers only
  `debug-beta.zxlab.pages.dev/api/private/market-agent/*` and uses a dedicated
  per-machine Service Token.
- Production and Preview have the additional audience configured. The Preview
  environment has the incremental Codex actor mapping; the existing encrypted
  `ZX_ACCESS_SERVICE_ACTORS` mapping was not overwritten.
- `MARKET_AGENT_SERVICE` remains bound to `zxlab-market-agent`.
- The local credentials are stored in macOS Keychain under account `codex` and
  the proxy-specific service names documented above. The signed helper is
  launched in the login user session; no credential value belongs in this
  repository, a prompt, logs, or ordinary environment files.

Acceptance evidence from the live deployment:

- `npm run access:debug` returned HTTP 200 and the dedicated Agent profile
  bootstrap.
- A request without credentials to `debug-beta` returned HTTP 403.
- The same Service Token sent to the ordinary `beta` entry returned an HTTP 302
  human-login redirect, so the machine identity did not cross the application
  boundary.
- A write request passed the Access scope check and was then safely rejected by
  domain validation with `INVALID_WATCHLIST_REVISION`.
- A deliberately invalid credential returned HTTP 403; restoring the Keychain
  credential restored HTTP 200.
- The focused Access test suite passed 21/21.

Native proxy acceptance completed on 2026-08-15:

- Interactive Terminal migration completed and retained the legacy Keychain
  items.
- A fresh Codex process initially reproduced
  `errSecInteractionNotAllowed`, proving that a correct item ACL alone does not
  place a background process in the login user bootstrap.
- Starting the same signed helper through `launchctl asuser` returned
  `clientIdReadable=true`, `clientSecretReadable=true`, and `ok=true` without
  widening the Keychain ACL.
- The wrapper now applies that login-session launch automatically while keeping
  the native operation allowlist and redacted output boundary.
- Codex managed execution additionally requires the approved sandbox-external
  `npm run access:debug` rule; this changes process isolation only and does not
  expose a Keychain value.
- A fresh managed Codex session then returned all three Keychain status values
  as `true` and completed the default read-only request with HTTP 200 using only
  the redacted profile summary.

For a new Codex session, start at the repository root and run:

```bash
npm run access:debug
```

An HTTP 200 confirms the complete machine-auth path. A Cloudflare HTTP 403
indicates an Access policy or credential problem. `ACCESS_SERVICE_ACTOR_UNREGISTERED`
or `ACCESS_SERVICE_ACTORS_INVALID` indicates the request reached Pages but the
actor mapping is missing or malformed. A Pages `404 Deployment Not Found`
indicates that the `debug-beta` branch alias is absent rather than an Access
failure.

The machine-auth path does not create or reuse a human browser session. A human
opening ZXLab in a browser may still be asked to sign in; that is expected and
must remain isolated from the Service Token flow.
