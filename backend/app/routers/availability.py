"""Availability cascade HTTP surface — single + bulk checks, monthly
stats, and recent-check log for the Settings tab."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..availability import check_availability_async
from ..availability.common import (
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    TERMINAL_STATUSES,
    normalize_domain,
)
from ..db import get_db, SessionLocal
from ..models import AvailabilityCheck

router = APIRouter(prefix="/availability", tags=["availability"])


class CheckIn(BaseModel):
    domain: str
    use_cache: bool = True


class CheckOut(BaseModel):
    domain: str
    status: str
    provider: str
    registrar: str = ""
    expires_on: date | None = None
    from_cache: bool = False
    checked_at: datetime | None = None


@router.post("/check", response_model=CheckOut)
async def check_one(payload: CheckIn) -> CheckOut:
    """Ad-hoc single-domain check. Used by the per-row "Recheck"
    buttons on the Database / Backlog pages."""
    domain = normalize_domain(payload.domain)
    if not domain:
        raise HTTPException(400, "domain required")
    result = await check_availability_async(
        domain, use_cache=payload.use_cache,
    )
    # Approach-1↔approach-2 bridge (extended 2026-05-18 to cover the
    # ad-hoc Recheck endpoints — previously only the dedicated
    # Availability Job runner called this, so per-row Recheck button
    # clicks updated the Database/Backlog Availability column but left
    # the Backlog Истечение column empty). Same semantics as the Job
    # path: idempotent, ban-aware, only writes when there's actually
    # new info, creates a row with status='analyzed' if the domain
    # isn't in Backlog yet.
    if result.expires_on is not None:
        from ..availability.backlog_upsert import upsert_backlog_expiration
        upsert_backlog_expiration(
            result.domain, result.expires_on, result.registrar,
        )
    return CheckOut(
        domain=result.domain,
        status=result.status,
        provider=result.provider,
        registrar=result.registrar,
        expires_on=result.expires_on,
        from_cache=result.from_cache,
        checked_at=result.checked_at,
    )


class BulkCheckIn(BaseModel):
    domains: list[str]
    use_cache: bool = True


class BulkCheckItem(BaseModel):
    domain: str
    status: str
    provider: str = ""
    registrar: str = ""
    expires_on: date | None = None
    from_cache: bool = False


class BulkCheckOut(BaseModel):
    checked: int
    items: list[BulkCheckItem]


@router.post("/bulk-check", response_model=BulkCheckOut)
async def bulk_check(payload: BulkCheckIn) -> BulkCheckOut:
    if not payload.domains:
        raise HTTPException(400, "no domains provided")
    seen: set[str] = set()
    todo: list[str] = []
    for raw in payload.domains:
        d = normalize_domain(raw)
        if not d or d in seen:
            continue
        seen.add(d)
        todo.append(d)
    if not todo:
        raise HTTPException(400, "no valid domains after normalization")

    # Share one client + one db session across the batch — per-provider
    # semaphores inside the cascade still cap concurrency.
    db = SessionLocal()
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            results = await asyncio.gather(*[
                check_availability_async(
                    d, use_cache=payload.use_cache, db=db, client=client,
                )
                for d in todo
            ])
    finally:
        db.close()

    items = [
        BulkCheckItem(
            domain=r.domain,
            status=r.status,
            provider=r.provider,
            registrar=r.registrar,
            expires_on=r.expires_on,
            from_cache=r.from_cache,
        )
        for r in results
    ]
    # Mirror the /check endpoint: write expires_on back to BacklogDomain
    # for every result that carries one (added 2026-05-18). The bulk
    # Recheck button on Backlog used to refresh the Availability column
    # but leave Истечение empty. Sequential upserts here — each call
    # opens its own short-lived session, and at typical bulk-recheck
    # sizes (tens to low hundreds) the per-row cost is negligible
    # compared to the cascade HTTP latency the user already waited
    # through above.
    from ..availability.backlog_upsert import upsert_backlog_expiration
    for r in results:
        if r.expires_on is not None:
            upsert_backlog_expiration(r.domain, r.expires_on, r.registrar)
    return BulkCheckOut(checked=len(items), items=items)


# --- Latest-per-domain helper for the Database/Backlog pages ---------------

class LatestRow(BaseModel):
    domain: str
    status: str
    provider: str
    registrar: str = ""
    expires_on: date | None = None
    checked_at: datetime | None = None


@router.post("/latest", response_model=list[LatestRow])
def latest_for_domains(
    payload: BulkCheckIn, db: Session = Depends(get_db),
) -> list[LatestRow]:
    """Return the most-recent terminal availability check per domain,
    skipping error/unknown rows. Used by the Database/Backlog pages to
    hydrate the Availability column without spawning fresh checks.

    `use_cache` on the payload is ignored — this is a read endpoint."""
    domains = [normalize_domain(d) for d in payload.domains]
    domains = [d for d in domains if d]
    if not domains:
        return []
    # SQLite-friendly: per-domain MAX(checked_at) subquery.
    sub = (
        db.query(
            AvailabilityCheck.domain.label("d"),
            func.max(AvailabilityCheck.checked_at).label("max_t"),
        )
        .filter(AvailabilityCheck.domain.in_(domains))
        .filter(AvailabilityCheck.status.in_(TERMINAL_STATUSES))
        .group_by(AvailabilityCheck.domain)
        .subquery()
    )
    rows = (
        db.query(AvailabilityCheck)
        .join(
            sub,
            (AvailabilityCheck.domain == sub.c.d)
            & (AvailabilityCheck.checked_at == sub.c.max_t),
        )
        .all()
    )
    return [
        LatestRow(
            domain=r.domain,
            status=r.status,
            provider=r.provider,
            registrar=r.registrar,
            expires_on=r.expires_on,
            checked_at=r.checked_at,
        )
        for r in rows
    ]


# --- Stats + recent log (Settings tab) -------------------------------------

class ProviderStats(BaseModel):
    provider: str
    sent: int = 0
    succeeded: int = 0
    failed: int = 0


class StatsOut(BaseModel):
    period_start: datetime
    providers: list[ProviderStats]


@router.get("/stats", response_model=StatsOut)
def monthly_stats(db: Session = Depends(get_db)) -> StatsOut:
    """Per-provider counts since the 1st of the current month."""
    now = datetime.utcnow()
    period_start = datetime(now.year, now.month, 1)
    rows = (
        db.query(
            AvailabilityCheck.provider,
            AvailabilityCheck.status,
            func.count(AvailabilityCheck.id),
        )
        .filter(AvailabilityCheck.checked_at >= period_start)
        .group_by(
            AvailabilityCheck.provider, AvailabilityCheck.status,
        )
        .all()
    )
    by_prov: dict[str, ProviderStats] = {}
    for provider, status, count in rows:
        s = by_prov.setdefault(provider, ProviderStats(provider=provider))
        s.sent += count
        if status == STATUS_ERROR:
            s.failed += count
        else:
            s.succeeded += count
    return StatsOut(
        period_start=period_start,
        providers=sorted(by_prov.values(), key=lambda p: p.provider),
    )


class RecentRow(BaseModel):
    id: int
    domain: str
    provider: str
    status: str
    checked_at: datetime
    latency_ms: int | None = None
    registrar: str = ""
    expires_on: date | None = None
    error_message: str = ""
    error_category: str = ""
    run_id: int | None = None


@router.get("/recent", response_model=list[RecentRow])
def recent_checks(
    limit: int = 100,
    run_id: int | None = None,
    db: Session = Depends(get_db),
) -> list[RecentRow]:
    """Recent check rows for the Settings log + per-Run filter (Errors
    page integration). `run_id` filters to one run's check log."""
    limit = max(1, min(limit, 1000))
    q = db.query(AvailabilityCheck)
    if run_id is not None:
        q = q.filter(AvailabilityCheck.run_id == run_id)
    rows = q.order_by(AvailabilityCheck.id.desc()).limit(limit).all()
    return [
        RecentRow(
            id=r.id,
            domain=r.domain,
            provider=r.provider,
            status=r.status,
            checked_at=r.checked_at,
            latency_ms=r.latency_ms,
            registrar=r.registrar,
            expires_on=r.expires_on,
            error_message=r.error_message,
            error_category=r.error_category,
            run_id=r.run_id,
        )
        for r in rows
    ]
