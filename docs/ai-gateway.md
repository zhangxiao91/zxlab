# Unified AI Gateway

ZXLab keeps Astro in static-output mode and implements AI generation in the
existing root-level Cloudflare Pages Functions architecture. No provider URL,
credential, model selection, or fallback decision is shipped to the browser.

## Call flow

1. Business code calls `generateAI()` for a complete JSON response or
   `streamAI()` for incremental SSE events from `src/lib/ai/client.ts`.
2. The client posts only `task`, `messages`, and generation parameters to
   `POST /api/ai/generate` or `POST /api/ai/stream`.
3. The Pages Function enforces access controls and validates method, content
   type, body size, task, messages, temperature, output-token limit, and allowed
   fields.
4. The task-policy layer applies safe defaults and task-specific caps. Known
   lightweight tasks select a deterministic low-cost tier.
5. Ambiguous tasks use the non-recursive selector chain DeepSeek V4 Flash,
   Terra Provider 1, then Terra Provider 2. Selector exhaustion uses the task
   default and never fails the business request.
6. The routing planner expands the selected capability tier into providers,
   switching provider before lowering capability. The full capability order is
   Sol, Kimi K3, Terra, then DeepSeek V4 Flash. Sol and Terra each have two
   independent provider candidates.
7. An OpenAI-compatible adapter owns the Chat Completions request format. The
   named DeepSeek adapter currently reuses that wire format while preserving a
   provider-specific extension point.
8. Structured output is parsed on the server. A single outer JSON Markdown fence
   is accepted; damaged JSON is never heuristically repaired.
9. The logger emits one sanitized record per attempt and one request summary.

The streaming route asks the selected provider for Chat Completions SSE and
forwards bounded text deltas without exposing provider credentials. Its event
order is `start`, one or more `attempt` and `delta` events, optional `reset`
events, then exactly one terminal `done` or `error` event. `reset` tells callers
to discard partial text before a retry or model fallback, preventing output
from two attempts from being concatenated. Client cancellation aborts the
active provider request.

ZX Signal calls the streaming endpoint server-to-server with its own encrypted
copy of `AI_GATEWAY_ACCESS_TOKEN`. Its browser UI never receives that token.
Signal reads the terminal `done.data.json` event for strict JSON tasks, falls
back to the non-streaming endpoint only when the stream route is unavailable,
and keeps ownership of prompt construction, domain schema validation, the
single briefing repair attempt, Memory semantics, and D1 persistence.

The Risk workbench uses the same boundary through `POST /api/risk/review`.
That browser-facing endpoint validates the Cloudflare Access assertion, accepts
only an `EvidencePack`, and calls this gateway server-to-server with the
encrypted token, preferring the streaming endpoint and using the non-streaming
endpoint as an availability fallback. The Risk page never receives the gateway
credential, provider configuration, or model fallback details beyond the
selected provider/model metadata returned after a successful review.

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

Streaming text example:

```ts
import { streamAI } from "../lib/ai/client";

let text = "";
for await (const event of streamAI({
  task: "notes-summary",
  messages: [{ role: "user", content: noteBody }],
  responseFormat: { type: "text" },
})) {
  if (event.type === "delta") text += event.text;
  if (event.type === "reset") text = "";
  if (event.type === "done") text = event.data.text;
  if (event.type === "error") throw new Error(event.error.message);
}
```

For JSON mode, deltas are only a progress preview. Callers must use
`event.data.json` from the terminal `done` event because the gateway parses and
validates the complete structured result before committing it.

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
GPT_PROVIDER1_BASE_URL=
GPT_PROVIDER1_API_KEY=
GPT_PROVIDER1_SOL_MODEL=
GPT_PROVIDER1_TERRA_MODEL=

GPT_PROVIDER2_BASE_URL=
GPT_PROVIDER2_SOL_API_KEY=
GPT_PROVIDER2_TERRA_API_KEY=
GPT_PROVIDER2_SOL_MODEL=
GPT_PROVIDER2_TERRA_MODEL=

KIMI_BASE_URL=https://api.moonshot.ai/v1
KIMI_API_KEY=
KIMI_K3_MODEL=

DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
```

The model values are deliberately environment-specific. They may be official
IDs or relay-provider IDs; source code never assumes they are identical.
Provider 2's Sol and Terra credentials are deliberately separate. The selector
cannot choose a provider or arbitrary model string; it returns only a validated
capability tier, confidence, and reason code.

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
| `signal-memory-consolidation` | 1,600 | 30 s | 60 s |

The gateway guarantees valid JSON for `responseFormat.type=json`; it does not
accept a caller-supplied JSON Schema. Signal therefore validates `data.json`
again with `@zxlab/signal-schema` before any D1 write.

Yuzi calls the non-streaming endpoint from its Worker with the server-only
access token and task `yuzi-turn`. That task is capped at 700 output tokens,
25 seconds per candidate, a 55-second total budget, and temperature 0.72. The
caller supplies telemetry source `yuzi`, validates the game schema and banned
phrases, and makes at most one repair request. Model failures leave its Durable
Object turn and version unchanged.

## Responses

`POST /api/ai/stream` responds with `text/event-stream`. Each SSE `data` field
contains one typed JSON event. Authentication or input failures detected before
streaming begins retain the normal JSON error response and HTTP status.

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

## Usage telemetry

Each actual provider attempt is recorded in the existing `zx-signal` D1 database
after the gateway has determined its terminal attempt outcome. Apply migrations
`0004_llm_usage_events.sql` and `0008_gateway_routing_telemetry.sql`, then bind
that same database to the Pages project as `LLM_USAGE_DB`. Writes use
`waitUntil` when available and are best effort:
a telemetry failure never changes an AI response.

`request_id` identifies a logical request; a row identifies a provider attempt.
Retry attempts receive their own row, while `fallback_depth` tracks the selected
candidate in the configured chain. Attempt rows also retain the sanitized
candidate ID, capability tier, provider instance, and provider HTTP status.
`llm_routing_events` records the selected tier, task-default versus selector
source, reason code, selector fallback, sanitized selector attempt trace, and
the expanded route candidate IDs. Both tables intentionally exclude
prompts, responses, headers, credentials, and caller metadata. Token fields are
only persisted when the provider returned them. Pricing is deliberately empty
until provider-confirmed prices are added to `functions/_lib/ai/telemetry.ts`.

`GET /api/status/llm?range=24h|7d|30d|today` returns the aggregated dashboard
only after Cloudflare Access verifies the shared Pages application configured
by `RISK_ACCESS_TEAM_DOMAIN` and `RISK_ACCESS_AUD`. The public Status page handles an unavailable or
unauthorized detailed module independently of its public device and Codex cards.

## Verification

The tests use injected adapters and never call a real model:

```bash
npm run typecheck:ai
npm run test:ai
npm run typecheck
npm run build
```
