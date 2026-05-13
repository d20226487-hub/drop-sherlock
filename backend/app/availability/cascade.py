"""Cascade orchestrator. Walks the user-configured provider order until
one returns a terminal status (available / registered), writing one
AvailabilityCheck history row per provider that responded.

Cache: a recent (within TTL hours) `available` or `registered` row for
the same domain short-circuits the cascade — no providers called, no
new rows written.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import httpx
from sqlalchemy.orm import Session

from ..app_settings import (
    get_availability_cascade_order,
    get_cache_ttl_hours,
    get_provider_rate_limits,
    is_provider_enabled,
)
from ..db import SessionLocal
from ..models import AvailabilityCheck
from . import dns as dns_provider
from . import domainr as domainr_provider
from . import rdap as rdap_provider
from . import whois as whois_provider
from .common import (
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    normalize_domain,
)


@dataclass
class AvailabilityResult:
    """Final cascade verdict the caller cares about."""
    domain: str
    status: str  # available | registered | error | unknown
    registrar: str = ""
    expires_on: date | None = None
    provider: str = ""  # which provider produced the terminal answer
    from_cache: bool = False
    checked_at: datetime | None = None


# Per-provider semaphores cap concurrent in-flight requests. Lazily
# created and resized when the user edits max_concurrent — the cascade
# reads the latest config every call.
_semaphores: dict[str, asyncio.Semaphore] = {}
_sema_max: dict[str, int] = {}


def _get_semaphore(provider: str) -> asyncio.Semaphore:
    limits = get_provider_rate_limits(provider)
    cap = limits["max_concurrent"]
    if _sema_max.get(provider) != cap:
        _semaphores[provider] = asyncio.Semaphore(cap)
        _sema_max[provider] = cap
    return _semaphores[provider]


async def _call_provider(
    provider: str, domain: str, client: httpx.AsyncClient,
) -> ProviderResult:
    """Dispatch to the right provider module + apply per-provider
    concurrency cap."""
    sem = _get_semaphore(provider)
    async with sem:
        if provider == "dns":
            return await dns_provider.check(domain)
        if provider == "rdap":
            return await rdap_provider.check(domain, client=client)
        if provider == "domainr":
            return await domainr_provider.check(domain, client=client)
        if provider == "whois":
            return await whois_provider.check(domain)
        return ProviderResult(
            provider=provider, status=STATUS_ERROR,
            error_message=f"unknown provider: {provider}",
        )


def _read_cached(db: Session, domain: str) -> AvailabilityCheck | None:
    """Return the most-recent terminal check for `domain` within the
    TTL window. Skips error/unknown rows — those don't satisfy the
    cache (caller wants to retry)."""
    ttl_hours = get_cache_ttl_hours()
    if ttl_hours <= 0:
        return None
    cutoff = datetime.utcnow() - timedelta(hours=ttl_hours)
    return (
        db.query(AvailabilityCheck)
        .filter(AvailabilityCheck.domain == domain)
        .filter(AvailabilityCheck.checked_at >= cutoff)
        .filter(AvailabilityCheck.status.in_(
            (STATUS_AVAILABLE, STATUS_REGISTERED),
        ))
        .order_by(AvailabilityCheck.checked_at.desc())
        .first()
    )


def _persist(
    db: Session, domain: str, results: list[ProviderResult], run_id: int | None,
) -> AvailabilityCheck | None:
    """Write one AvailabilityCheck row per provider that responded.
    Returns the row that holds the terminal answer (if any)."""
    rows: list[AvailabilityCheck] = []
    now = datetime.utcnow()
    for r in results:
        row = AvailabilityCheck(
            domain=domain,
            provider=r.provider,
            status=r.status,
            checked_at=now,
            latency_ms=r.latency_ms,
            registrar=r.registrar or "",
            expires_on=r.expires_on,
            error_message=r.error_message or "",
            error_category=r.error_category or "",
            raw_response=r.raw_response or "",
            run_id=run_id,
        )
        db.add(row)
        rows.append(row)
    db.commit()
    terminal = next(
        (
            row for row in rows
            if row.status in (STATUS_AVAILABLE, STATUS_REGISTERED)
        ),
        None,
    )
    return terminal


async def check_availability_async(
    domain: str,
    *,
    run_id: int | None = None,
    use_cache: bool = True,
    db: Session | None = None,
    client: httpx.AsyncClient | None = None,
) -> AvailabilityResult:
    """Walk the configured cascade for one domain.

    `run_id` links the persisted check rows to the Run that triggered
    this call (None for ad-hoc / bulk recheck from the UI).

    `use_cache=False` forces a re-check even if a recent terminal row
    exists — used by the "Recheck" buttons on the Database/Backlog
    pages.

    `db` / `client` accept caller-supplied handles so a batch can share
    one Session + one httpx pool. When omitted, fresh ones are spawned
    per call.
    """
    domain = normalize_domain(domain)
    if not domain:
        return AvailabilityResult(
            domain="", status=STATUS_ERROR, provider="",
            checked_at=datetime.utcnow(),
        )

    own_db = db is None
    if db is None:
        db = SessionLocal()
    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=10.0)

    try:
        if use_cache:
            cached = _read_cached(db, domain)
            if cached is not None:
                return AvailabilityResult(
                    domain=domain,
                    status=cached.status,
                    registrar=cached.registrar or "",
                    expires_on=cached.expires_on,
                    provider=cached.provider,
                    from_cache=True,
                    checked_at=cached.checked_at,
                )

        # Live cascade
        order = get_availability_cascade_order()
        results: list[ProviderResult] = []
        terminal: ProviderResult | None = None
        for provider in order:
            if not is_provider_enabled(provider):
                continue
            r = await _call_provider(provider, domain, client)
            results.append(r)
            if r.is_terminal:
                terminal = r
                break

        # Nothing responded terminally → if we have at least one error
        # result, surface that. Otherwise return 'unknown'.
        if terminal is None:
            persisted = _persist(db, domain, results, run_id)
            # Pick the most informative non-terminal — prefer error over
            # unknown so the user sees a real reason.
            for r in results:
                if r.status == STATUS_ERROR:
                    return AvailabilityResult(
                        domain=domain,
                        status=STATUS_ERROR,
                        provider=r.provider,
                        checked_at=datetime.utcnow(),
                    )
            return AvailabilityResult(
                domain=domain,
                status="unknown",
                provider=results[-1].provider if results else "",
                checked_at=datetime.utcnow(),
            )

        _persist(db, domain, results, run_id)
        return AvailabilityResult(
            domain=domain,
            status=terminal.status,
            registrar=terminal.registrar,
            expires_on=terminal.expires_on,
            provider=terminal.provider,
            from_cache=False,
            checked_at=datetime.utcnow(),
        )
    finally:
        if own_client:
            await client.aclose()
        if own_db:
            db.close()


def check_availability(
    domain: str,
    *,
    run_id: int | None = None,
    use_cache: bool = True,
) -> AvailabilityResult:
    """Sync wrapper for non-async callers. Spawns a one-shot event
    loop. Don't use inside an existing async context — call
    check_availability_async directly there."""
    return asyncio.run(
        check_availability_async(
            domain, run_id=run_id, use_cache=use_cache,
        ),
    )
