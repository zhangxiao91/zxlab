# Local Cloudflare Access Credential Proxy

ZXLab uses a signed native macOS helper for cross-session machine checks against the
isolated `debug-beta` Access application. The helper, rather than Node or Codex,
owns both Keychain reads and the outbound HTTPS request.

The Node wrapper starts the helper through `launchctl asuser` for the current
macOS login UID. This is required because a Codex background process is outside
the interactive login bootstrap and otherwise receives `errSecInteractionNotAllowed`
even when the helper's Keychain ACL is correct. It does not grant another user
or application access to the credentials.

Codex managed shell execution must also use the approved sandbox-external rule
for `npm run access:debug`; the restricted sandbox blocks login Keychain access
before the helper ACL is evaluated. Ordinary interactive Terminal use does not
need this escalation. The approval changes only the process sandbox and never
exposes the Keychain values to Codex.

## Security boundary

- The destination is compiled as `https://debug-beta.zxlab.pages.dev`.
- The helper is ad-hoc signed with the hardened runtime enabled; the generated
  executable is ignored by Git.
- Only enumerated Market Agent operations are accepted.
- Arbitrary URLs, methods, paths, bodies, `DELETE`, and purge operations are not
  supported.
- Redirects are never followed.
- Cookies are disabled.
- Standard TLS verification remains enabled, including when an HTTP or SOCKS
  proxy is selected from `HTTPS_PROXY` or `ALL_PROXY`.
- Proxy URLs containing embedded credentials are ignored.
- Cloudflare credentials and raw private response bodies never leave the native
  process. Output is limited to HTTP status, bounded request identifiers, error
  codes, and operation-specific summaries.

The helper uses separate Keychain items and leaves the legacy entries intact:

- account: `codex`
- service: `zxlab.debug-access.proxy.client-id`
- service: `zxlab.debug-access.proxy.client-secret`

## One-time setup

Run setup from an interactive Terminal, not from a Codex prompt:

```bash
npm run access:debug:setup
```

`migrate` asks macOS Keychain to authorize the signed helper to read the legacy
items, writes helper-owned replacements, and retains the legacy items. If the
legacy items are unavailable, enter both values directly without exposing them
in shell history or process arguments:

```bash
npm run access:debug -- provision
```

Rebuilding changes the ad-hoc signed executable. After an intentional rebuild,
run `migrate` or `provision` again if macOS no longer accepts the existing item
ACL.

## Safe operations

```bash
npm run access:debug
npm run access:debug -- status
npm run access:debug -- today
npm run access:debug -- quality
npm run access:debug -- watchlist-status
npm run access:debug -- run-create --instrument SSE:600000
npm run access:debug -- run-status --run-id RUN_ID
```

`run-create` is an explicit beta write that creates a Market Agent acceptance
Run and may consume model quota. It does not accept a free-form request body.
`verify:market-agent:run` uses only `run-create` and `run-status`; Node receives
the sanitized Run status and narration provenance needed for acceptance, not
the generated report or Evidence payload.

## Verification

```bash
npm run test:access-debug
npm run access:debug -- status
npm run access:debug
```

The first command compiles a temporary helper and runs its allowlist and
redaction self-test. The final command is the live machine-auth check and must
return HTTP 200 before the cross-session path is considered available.
