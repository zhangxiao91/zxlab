# zxlab Risk API

Private FastAPI backend for `/lab/risk`. It separates market normalization, immutable portfolio ledger events, deterministic risk calculation, and read-only evidence review.

## Local run

Requires Python 3.12 or newer and Docker.

```bash
docker compose up -d postgres
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/alembic revision --autogenerate -m 'initial risk schema'
.venv/bin/alembic upgrade head
RISK_REVIEW_MODE=mock .venv/bin/uvicorn risk_api.main:app --port 8421
```

The Astro frontend uses `http://127.0.0.1:8421` by default and falls back to its complete deterministic fixture when the API is unavailable.

Set `RISK_REVIEW_MODE=openai` only on the private server. By default the personal setup reads `/Users/zhangyang/Developer/.env`; it accepts either `OPENAI_API_KEY`/`OPENAI_BASE_URL` or the existing `apikey`/`baseurl` names. Override the location with `RISK_OPENAI_ENV_FILE`. The key is never sent to the browser. Any SDK or provider failure returns a structured Mock review with the failure class in `limitations`.

## Tests

```bash
.venv/bin/pytest
```

The tests cover quote normalization and freshness, provider fallback, immutable transaction calculation, CSV idempotency, leverage and concentration rules, stale-data blocking, cited Review output, and trading-instruction rejection.
