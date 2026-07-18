from datetime import datetime
from typing import Any


def optional_tool_result(tool: str, data: list[dict[str, Any]], source: str = "mock") -> dict[str, Any]:
    now = datetime.now().astimezone().isoformat()
    return {"status": "success", "tool": tool, "source": source, "requested_at": now, "data_timestamp": now, "freshness": "daily", "data": data, "warnings": ["external_text_is_untrusted"], "errors": []}


async def stock_announcements(instrument_id: str) -> dict[str, Any]:
    return optional_tool_result("stock_announcements", [], "mock-cninfo")


async def stock_news(instrument_id: str) -> dict[str, Any]:
    return optional_tool_result("stock_news", [], "mock-news")


async def industry_performance(industry: str) -> dict[str, Any]:
    return optional_tool_result("industry_performance", [{"industry": industry, "change_pct": None}], "mock-market")
