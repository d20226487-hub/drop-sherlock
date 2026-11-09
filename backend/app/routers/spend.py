"""Spend API (added 2026-11-09) — the Dashboard's Spend section and the
non-AI API prices. See app/spend.py for what is recorded and how it is
priced. AI token prices stay in Settings → Pricing (/settings/pricing)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import spend

router = APIRouter(prefix="/spend", tags=["spend"])


@router.get("/summary")
def spend_summary(period: str = "this_month") -> dict:
    """Totals, per-model / per-feature breakdowns and the last 12 months.
    Sync on purpose: FastAPI runs it in the threadpool, off the loop."""
    try:
        return spend.summary(period)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class SpendPricingIn(BaseModel):
    ahrefs_included_units: int | None = Field(None, ge=0)
    ahrefs_usd_per_million: float | None = Field(None, ge=0)
    whoisfreaks_usd_per_credit: float | None = Field(None, ge=0)
    domainr_usd_per_request: float | None = Field(None, ge=0)


@router.get("/pricing")
def get_spend_pricing() -> dict:
    return spend.get_pricing()


@router.put("/pricing")
def put_spend_pricing(payload: SpendPricingIn) -> dict:
    try:
        return spend.set_pricing(payload.model_dump(exclude_none=True))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
