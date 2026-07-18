from datetime import date

import pytest
from pydantic import ValidationError

from risk_api.main import build_evidence_pack
from risk_api.review_agent.schemas import ReviewOutput
from risk_api.review_agent.service import run_review


@pytest.mark.asyncio
async def test_mock_review_is_structured_cited_and_non_trading() -> None:
    output, mode = await run_review(build_evidence_pack(date(2026, 7, 18)), force_mock=True)
    assert mode == "mock"
    assert all(item.evidence_ids for item in output.main_risks)
    serialized = output.model_dump_json()
    assert "立即买入" not in serialized
    assert output.unknowns


def test_schema_rejects_direct_trading_instruction() -> None:
    with pytest.raises(ValidationError, match="forbidden trading instruction"):
        ReviewOutput(summary="立即卖出该持仓", main_risks=[], plan_violations=[], operation_review=[], counterfactuals=[], unknowns=[], questions_for_user=[], limitations=[])
