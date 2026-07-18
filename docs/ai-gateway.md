# Unified AI Gateway

ZXLab keeps Astro in static-output mode and implements AI generation in the
existing root-level Cloudflare Pages Functions architecture. No provider URL,
credential, model selection, or fallback decision is shipped to the browser.

## Call flow

1. Business code calls `generateAI()` from `src/lib/ai/client.ts`.
2. The client posts only `task`, `messages`, and generation parameters to
   `POST /api/ai/generate`.
3. The Pages Function enforces access controls and validates method, content
   type, body size, task, messages, temperature, output-token limit, and allowed
   fields.
4. The task-policy layer applies safe defaults and task-specific caps.
5. The router attempts the centrally configured candidates in this exact order:
   Provider 1 GPT-5.6, Provider 1 GPT-5.5, Provider 2 GPT-5.5, DeepSeek V4 Pro.
6. An OpenAI-compatible adapter owns the Chat Completions request format. The
   named DeepSeek adapter currently reuses that wire format while preserving a
   provider-specific extension point.
7. Structured output is parsed on the server. A single outer JSON Markdown fence
   is accepted; damaged JSON is never heuristically repaired.
8. The logger emits one sanitized record per attempt and one request summary.

ZX Signal calls this endpoint server-to-server with its own encrypted copy of
`AI_GATEWAY_ACCESS_TOKEN`. Its browser UI never receives that token. Signal
keeps ownership of prompt construction, domain schema validation, the single
briefing repair attempt, Memory semantics, and D1 persistence.

The Risk workbench uses the same boundary through `POST /api/risk/review`.
That browser-facing endpoint validates the Cloudflare Access assertion, accepts
only an `EvidencePack`, and calls this gateway server-to-server with the
encrypted token. The Risk page never receives the gateway credential, provider
configuration, or model fallback details beyond the selected provider/model
metadata returned after a successful review.

## Business-side example

```ts
import { generateAI } from "../lib/ai/client";

const result = await generateAI({
  task: "notes-summary",
  messages: [{ role: "user", content: noteBody }],
  temperature: 0.4,
  maxOutputTokens: 1_200,
  responseFormat: { type: "text" },
});

console.log(result.text);
```

Callers cannot set a provider, model, base URL, API key, or fallback chain.
Unknown input fields are rejected rather than silently forwarded.

## Fallback and retry decisions

| Normalized condition | Retry same candidate once | Try next candidate |
| --- | --- | --- |
| Network failure | Yes | Yes |
| HTTP 429 | Yes | Yes |
| HTTP 502, 503, 504 | Yes | Yes |
| Candidate timeout | No | Yes |
| HTTP 500 | No | Yes |
| Quota exhausted or balance unavailable | No | Yes |
| Model temporarily unavailable | No | Yes |
| Empty or unparseable provider response | No | Yes |
| Invalid requested JSON output | No | Yes |
| Context too long | No | No |
| Provider 4xx parameter/authentication error | No | No |
| Invalid ZXLab input or missing server configuration | No | No |

Transient retries wait 250 ms plus up to 100 ms of cryptographic jitter. Each
candidate has a 30-second default timeout. A request has a 75-second default
total budget, and no later retry or fallback begins after that deadline.

## Environment configuration

Use `.dev.vars.example` as the local template. The binding contract is declared
once by `AIEnv` in `functions/_lib/ai/config.ts`, because this Pages project does
not currently have a root Wrangler configuration from which to generate types.

Required provider settings:

```env
PROVIDER1_BASE_URL=
PROVIDER1_API_KEY=
PROVIDER1_GPT56_MODEL=
PROVIDER1_GPT55_MODEL=

PROVIDER2_BASE_URL=
PROVIDER2_API_KEY=
PROVIDER2_GPT55_MODEL=

DEEPSEEK_BASE_URL=
DEEPSEEK_API_KEY=
DEEPSEEK_V4_PRO_MODEL=
```

The model values are deliberately environment-specific. They may be official
IDs or relay-provider IDs; source code never assumes they are identical.

Security settings:

```env
ENVIRONMENT=production
AI_GATEWAY_ACCESS_TOKEN=
AI_GATEWAY_ALLOWED_ORIGINS=https://zx-dx.xyz

RISK_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
RISK_ACCESS_AUD=
```

Store API keys and the access token as Cloudflare encrypted secrets, not plain
variables. The current site has no shared end-user authentication layer, so the
safe production default is an internal bearer token. Do not put it in browser
JavaScript. A future authenticated browser feature can supply an identity-backed
limiter through the optional `AI_RATE_LIMITER` interface or place Cloudflare WAF
rate limiting in front of the route; until then, production fails closed if both
controls are absent.

`RISK_ACCESS_TEAM_DOMAIN` and `RISK_ACCESS_AUD` are non-secret runtime values
from the Cloudflare Access application protecting `/lab/risk*` and
`/api/risk/review`. The Function verifies the assertion signature against the
team JWKS and checks both issuer and audience. The Access allow policy is
restricted to the personal account email; browser Origin headers are not used
as authentication.

ZX Signal task policies are intentionally separate from generic callers:

| Task | Output cap | Candidate timeout | Total budget |
| --- | ---: | ---: | ---: |
| `signal-editorial-filter` | 4,000 | 30 s | 75 s |
| `signal-briefing` | 4,000 | 30 s | 75 s |
| `signal-annotation-reply` | 1,200 | 20 s | 40 s |
| `signal-memory-extraction` | 800 | 20 s | 40 s |

The gateway guarantees valid JSON for `responseFormat.type=json`; it does not
accept a caller-supplied JSON Schema. Signal therefore validates `data.json`
again with `@zxlab/signal-schema` before any D1 write.

## Responses

Success:

```json
{
  "ok": true,
  "data": {
    "text": "Summary text",
    "provider": "provider1",
    "model": "configured-provider-model-id",
    "fallbackIndex": 0,
    "latencyMs": 1234,
    "usage": { "inputTokens": 100, "outputTokens": 200, "totalTokens": 300 }
  },
  "requestId": "c5e8c79e-1e64-4fc0-9487-95c5ead0c945"
}
```

For `responseFormat: { "type": "json" }`, `data.json` contains the parsed JSON
value and `data.text` contains its canonical serialized representation.

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "ALL_CANDIDATES_FAILED",
    "message": "AI service is temporarily unavailable.",
    "attempts": 4
  },
  "requestId": "2efaa6c7-dd6f-4b9c-aa34-c6d1a156cf18"
}
```

Production responses never contain provider error bodies, credentials, request
messages, or environment values. Development responses add only a normalized
error code.

## Verification

The tests use injected adapters and never call a real model:

```bash
npm run typecheck:ai
npm run test:ai
npm run typecheck
npm run build
```
