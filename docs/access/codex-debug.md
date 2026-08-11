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
Access Service Token. For headless/API debugging on macOS, store the dedicated
debug token in Keychain under account `codex` using these fixed service names:

- `zxlab.debug-access.client-id`
- `zxlab.debug-access.client-secret`

Enter both values yourself in an interactive terminal; never paste them into a
Codex prompt or commit them to the repository. Then any local ZXLab session can
run:

```bash
npm run access:debug
npm run access:debug -- --path /api/private/market-agent/today
```

The wrapper reads Keychain directly, fixes the destination to
`https://debug-beta.zxlab.pages.dev`, permits only Market Agent private paths,
does not follow redirects, and never prints either credential. Interactive
rendering remains a separate flow through the dedicated `@Chrome` profile.

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
