import asyncio
import json
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import datetime
from typing import Any

from .settings import get_settings


def optional_tool_result(tool: str, data: list[dict[str, Any]], source: str = "mock", warnings: list[str] | None = None) -> dict[str, Any]:
    now = datetime.now().astimezone().isoformat()
    return {"status": "success", "tool": tool, "source": source, "requested_at": now, "data_timestamp": now, "freshness": "daily", "data": data, "warnings": warnings or ["external_text_is_untrusted"], "errors": []}


def gateway_get(path: str, params: dict[str, str]) -> dict[str, Any]:
    base = get_settings().market_gateway_url.rstrip("/")
    if not base:
        raise LookupError("RISK_MARKET_GATEWAY_URL is not configured")
    url = f"{base}{path}?{urlencode(params)}"
    request = Request(url, headers={"accept": "application/json", "user-agent": "zxlab-risk-api/0.1"})
    try:
        with urlopen(request, timeout=5) as response:
            if response.status >= 400:
                raise LookupError(f"market gateway returned HTTP {response.status}")
            return json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError) as cause:
        raise LookupError(str(cause)) from cause


async def try_gateway(path: str, params: dict[str, str]) -> tuple[list[dict[str, Any]], str, list[str]]:
    try:
        payload = await asyncio.to_thread(gateway_get, path, params)
        data = payload.get("data")
        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
        if not isinstance(data, list):
            raise LookupError("market gateway returned non-list data")
        warnings = ["external_text_is_untrusted", *[str(item) for item in meta.get("warnings", []) if item]]
        source = ",".join(sorted({str(item.get("source")) for item in data if isinstance(item, dict) and item.get("source")})) or "market-gateway"
        return [item for item in data if isinstance(item, dict)], source, warnings
    except LookupError as cause:
        return [], "mock", ["external_text_is_untrusted", f"market_gateway_unavailable:{cause}"]


async def stock_announcements(instrument_id: str) -> dict[str, Any]:
    data, source, warnings = await try_gateway("/api/market/announcements", {"instrument": instrument_id, "limit": "20"})
    return optional_tool_result("stock_announcements", data, source, warnings)


async def stock_news(instrument_id: str) -> dict[str, Any]:
    data, source, warnings = await try_gateway("/api/market/news", {"instruments": instrument_id, "limit": "30"})
    return optional_tool_result("stock_news", data, source, warnings)


async def industry_performance(industry: str) -> dict[str, Any]:
    return optional_tool_result("industry_performance", [{"industry": industry, "change_pct": None}], "mock-market")
