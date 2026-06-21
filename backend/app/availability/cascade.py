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
from . import whoisfreaks as whoisfreaks_provider
from .common import (
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_NOT_SUPPORTED,
    STATUS_REGISTERED,
    normalize_domain,
)
from .suffix import (
    is_multilabel_public_suffix_domain,
    is_private_suffix_domain,
)

# Provider the cascade is pinned to for "double extension" domains
# (multi-label ICANN suffixes like com.ua / net.uk / co.uk). RDAP is
# unreliable for these ccTLD second levels, so they're checked with one
# provider that handles them well. Switched WhoisFreaks → Domainr
# (2026-06-16): WhoisFreaks credits ran out (401), and Domainr (Fastly)
# resolves these ccTLDs correctly, is faster (~0.8s), and has a much
# higher rate ceiling (clean to ≥48 concurrent / ~39 rps in testing).
_DOUBLE_EXTENSION_PROVIDER = "domainr"


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


@dataclass
class CascadeOutcome:
    """Network-only cascade result: the caller-facing verdict PLUS the raw
    provider trace, with NO DB side effects. Returned by
    `run_cascade_network`. The single-domain/Recheck path
    (`check_availability_async`) persists the trace row-by-row via
    `_persist`; the batched availability runner bulk-inserts the whole
    chunk's traces in one transaction (2026-06-21 throughput work)."""
    result: AvailabilityResult
    provider_results: list[ProviderResult]


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


# Dedicated httpx client for the metered HTTP providers (Domainr, live
# WhoisFreaks). Kept SEPARATE from the runner's shared client (added
# 2026-06-16): RDAP — whether direct or proxied — can hang for tens of
# seconds, and when Domainr shared that one client/pool the slow RDAP
# requests starved it (~1s in isolation degraded to 10-14s timeouts in a
# live run). These providers always go direct (no proxy), are fast, and
# benefit from their own keep-alive pool to Fastly / WhoisFreaks. Module-
# global + lazily (re)created; lives for the process like the proxy pool.
_metered_client: httpx.AsyncClient | None = None
_METERED_TIMEOUT = httpx.Timeout(12.0)
_METERED_LIMITS = httpx.Limits(max_connections=128, max_keepalive_connections=64)


def _metered_provider_client() -> httpx.AsyncClient:
    global _metered_client
    if _metered_client is None or _metered_client.is_closed:
        _metered_client = httpx.AsyncClient(
            timeout=_METERED_TIMEOUT, limits=_METERED_LIMITS,
        )
    return _metered_client


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
            # Dedicated client — isolate fast Domainr from slow RDAP (see
            # `_metered_provider_client`).
            return await domainr_provider.check(
                domain, client=_metered_provider_client(),
            )
        if provider == "whois":
            return await whois_provider.check(domain)
        if provider == "whoisfreaks":
            # Metered + direct, same isolation rationale as Domainr.
            return await whoisfreaks_provider.check(
                domain, client=_metered_provider_client(),
            )
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


def _psl_not_supported_result() -> ProviderResult:
    """The single trace row emitted for a domain under a PRIVATE
    multi-label PSL suffix (e.g. jcg.us.com) — the gTLD/ccTLD registry
    can't authoritatively confirm it, so we refuse to guess `available`.
    Shared by both the persisting and network-only entry points."""
    return ProviderResult(
        provider="psl",
        status=STATUS_NOT_SUPPORTED,
        error_message=(
            "registered under a private multi-label suffix; "
            "the gTLD/ccTLD registry can't authoritatively "
            "confirm availability"
        ),
    )


def _build_availability_result(
    domain: str,
    results: list[ProviderResult],
    terminal: ProviderResult | None,
) -> AvailabilityResult:
    """Translate a finished provider walk into the caller-facing verdict.
    Shared by `check_availability_async` (persisting) and
    `run_cascade_network` (batched) so both produce identical verdicts.

    When nothing answered terminally, prefer the first error result so the
    user sees a real reason; fall back to 'unknown' when even errors are
    absent."""
    if terminal is None:
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
    return AvailabilityResult(
        domain=domain,
        status=terminal.status,
        registrar=terminal.registrar,
        expires_on=terminal.expires_on,
        provider=terminal.provider,
        from_cache=False,
        checked_at=datetime.utcnow(),
    )


async def run_cascade_network(
    domain: str, *, client: httpx.AsyncClient,
) -> CascadeOutcome:
    """Walk the configured cascade for one domain over the NETWORK ONLY —
    no cache read, no persistence, no DB session at all. Returns the
    verdict + the provider trace so a batched caller can bulk-write every
    row of a chunk in a single transaction.

    The private-suffix guard and the multilabel-suffix provider pinning
    are pure local PSL lookups (microseconds), so they still apply here.
    `check_availability_async` wraps this with the cache short-circuit and
    the per-row `_persist` for the single-domain / Recheck path; the
    availability runner calls it directly and owns the bulk write."""
    domain = normalize_domain(domain)
    if not domain:
        return CascadeOutcome(
            AvailabilityResult(
                domain="", status=STATUS_ERROR, provider="",
                checked_at=datetime.utcnow(),
            ),
            [],
        )

    # Private-suffix guard — refuse to guess (see `_psl_not_supported_result`).
    if is_private_suffix_domain(domain):
        psl_result = _psl_not_supported_result()
        return CascadeOutcome(
            AvailabilityResult(
                domain=domain,
                status=STATUS_NOT_SUPPORTED,
                provider="psl",
                from_cache=False,
                checked_at=datetime.utcnow(),
            ),
            [psl_result],
        )

    order = get_availability_cascade_order()
    # Double-extension domains (com.ua / net.uk / co.uk …) get pinned to a
    # single provider — RDAP + the rest are unreliable for these ccTLD
    # second levels.
    if is_multilabel_public_suffix_domain(domain):
        order = [_DOUBLE_EXTENSION_PROVIDER]
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
    return CascadeOutcome(
        _build_availability_result(domain, results, terminal), results,
    )


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
    one httpx pool (and optionally a DB session for sync callers). When
    omitted, fresh ones are spawned per call.

    DB sessions are never held across the provider awaits (refactored
    2026-05-16). Earlier behavior held one session for the full cascade
    duration; a 1000-domain availability run with `_OUTER_CONCURRENCY=8`
    in the parent runner kept ≥8 sessions open during the slow provider
    HTTP calls, exhausting the 15-slot pool whenever FE polling + a
    concurrent whois retry stacked on top. Each DB step now opens its
    own short-lived session: cache check (if `use_cache`) and the
    terminal `_persist` write. The provider await loop runs with NO
    session held."""
    domain = normalize_domain(domain)
    if not domain:
        return AvailabilityResult(
            domain="", status=STATUS_ERROR, provider="",
            checked_at=datetime.utcnow(),
        )

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=10.0)

    def _open_session() -> tuple[Session, bool]:
        """Return (session, owned). If the caller passed `db`, reuse it
        (caller closes); otherwise open a fresh one we'll close right
        after the sync step."""
        if db is not None:
            return db, False
        return SessionLocal(), True

    try:
        # --- Phase 0: private-suffix guard (no providers, no Ahrefs).
        # "Double domains" under a PRIVATE PSL suffix (e.g. jcg.us.com)
        # can't be authoritatively checked — the parent gTLD's RDAP/WHOIS
        # returns "not found", which the cascade would mis-read as
        # AVAILABLE. Short-circuit to `not_supported` BEFORE the cache +
        # providers so we never emit that false positive (and never spend
        # Domainr quota on an unanswerable name). Detection is a local
        # PSL lookup (~microseconds), so it's cheap to re-run every call
        # rather than cache. We still persist one row so the verdict
        # surfaces in the Database/Backlog column + per-run trace.
        if is_private_suffix_domain(domain):
            psl_result = _psl_not_supported_result()
            s, owned = _open_session()
            try:
                _persist(s, domain, [psl_result], run_id)
            finally:
                if owned:
                    s.close()
            return AvailabilityResult(
                domain=domain,
                status=STATUS_NOT_SUPPORTED,
                provider="psl",
                from_cache=False,
                checked_at=datetime.utcnow(),
            )

        # --- Phase 1: cache check (short session, no await held)
        if use_cache:
            s, owned = _open_session()
            try:
                cached = _read_cached(s, domain)
            finally:
                if owned:
                    s.close()
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

        # --- Phase 2: live cascade (NO session held across provider awaits).
        # The provider walk + verdict-building is shared with the batched
        # runner via `run_cascade_network` (no DB access inside).
        outcome = await run_cascade_network(domain, client=client)

        # --- Phase 3: persist the trace (short session, no await held).
        s, owned = _open_session()
        try:
            _persist(s, domain, outcome.provider_results, run_id)
        finally:
            if owned:
                s.close()

        return outcome.result
    finally:
        if own_client:
            await client.aclose()


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
