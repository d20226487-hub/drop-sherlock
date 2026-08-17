"""Residential-proxy egress pool for the Wayback pillar (added 2026-08-11).

Separate from the Webshare/RDAP pool in `availability/` on purpose. The two
upstreams punish opposite things:

  * RDAP registries throttle by IP and are fine with DATACENTER proxies.
  * archive.org throttles by IP AND tarpits datacenter ranges — the datacenter
    pool measured ~60% timeouts vs direct, while genuine residential/ISP IPs
    held ~85-90%. So Wayback needs its OWN list URL, pointed at a residential
    plan, and must never borrow the RDAP pool.

What it buys (measured 2026-08-08, 50 domains, production path, rested IP):
per-request speed is identical — 4.24s direct vs 4.26s residential. The win is
COMPLETENESS. A single IP starts getting refused ~4 requests into a batch, so
direct finished 28/50 domains vs residential's 43/50. That's why this is
opt-in, per-phase, and instantly revertible: flip `enabled` off and every
Wayback request goes direct again.

Per-IP cooldown is the critical difference from `providers/wayback.py`'s gate.
That one is global (correct for a single egress IP): one 429 pauses everything.
With N rotating IPs that would be actively wrong — one bad proxy would stall
the other 22 and throw away the whole benefit. Here each egress identity
(each proxy URL, plus "direct") carries its OWN cooldown, so a throttled IP is
skipped while the rest keep working.

All state is module-global and event-loop-confined (same model as
availability/proxies.py), so no locking is needed.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from .app_settings import (
    get_wayback_proxies_config,
    get_wayback_proxy_list_url,
)

log = logging.getLogger(__name__)

# The list download itself goes direct (we're fetching the list, not proxying).
_FETCH_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_RETRY_MAX = 3

# Matches WaybackClient.timeout — CDX can legitimately take ~90s on
# deep-history domains, and a residential hop only adds to that.
_CLIENT_TIMEOUT = httpx.Timeout(90.0, connect=15.0)

# How long a proxy is skipped after archive.org pushes back through it.
_COOLDOWN_SEC = 60.0

# Sentinel egress key for the non-proxied path.
DIRECT = "direct"

_proxies: list[str] = []
_last_fetch_at: str | None = None
_last_error: str | None = None
_last_count: int = 0

_pool: dict[str, httpx.AsyncClient] = {}
_order: list[str] = []
_cooldown: dict[str, float] = {}
_rr_index = 0
_pool_sig: tuple[str, ...] = ()


# --- list download ----------------------------------------------------------

async def refresh() -> dict:
    """Download + parse the residential list into the cache. Returns `status()`.

    Resilience mirrors availability/webshare.refresh(): a failed download KEEPS
    the last-good list (a transient blip must not empty the pool mid-run) and
    retries with backoff. Only an explicitly cleared URL empties it."""
    global _proxies, _last_fetch_at, _last_error, _last_count
    # Lazy: the parser is generic (`ip:port:user:pass` and friends) and worth
    # reusing, but importing it at module level would drag the whole
    # `availability` package (cascade + every provider) into any module that
    # touches this pool — including providers/wayback.py on the hot path.
    from .availability.webshare import parse_webshare_list

    url = get_wayback_proxy_list_url()
    if not url:
        _proxies = []
        _last_count = 0
        _last_error = None
        _rebuild_pool()
        return status()

    last_exc: Exception | None = None
    for attempt in range(_RETRY_MAX + 1):
        try:
            async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
                r = await client.get(url)
            if r.status_code >= 400:
                raise RuntimeError(
                    f"proxy list returned HTTP {r.status_code}: {r.text[:150]}"
                )
            parsed = parse_webshare_list(r.text)
            if not parsed:
                # A 2xx with a junk body is a failure, not a reason to wipe a
                # working pool.
                raise RuntimeError("proxy list downloaded but parsed to 0 proxies")
            _proxies = parsed
            _last_count = len(parsed)
            _last_fetch_at = datetime.now(timezone.utc).isoformat()
            _last_error = None
            _rebuild_pool()
            log.info("Wayback residential proxies refreshed: %d", _last_count)
            return status()
        except Exception as e:  # noqa: BLE001
            last_exc = e
            if attempt < _RETRY_MAX:
                await asyncio.sleep(min(10.0, 2 ** attempt))
                continue

    _last_error = f"{type(last_exc).__name__}: {last_exc}"
    log.warning(
        "Wayback proxy refresh failed (kept %d cached): %s",
        _last_count, _last_error,
    )
    return status()


async def scheduled_refresh() -> None:
    """Boot / cron entrypoint — never lets a failure reach the scheduler."""
    try:
        await refresh()
    except Exception:  # noqa: BLE001
        log.exception("scheduled Wayback proxy refresh failed")


def get_cached_proxies() -> list[str]:
    return list(_proxies)


def status() -> dict:
    """Write-only status for the UI. Excludes the URL (it embeds a token)."""
    cfg = get_wayback_proxies_config()
    now = time.monotonic()
    return {
        "configured": bool(get_wayback_proxy_list_url()),
        "enabled": cfg["enabled"],
        "use_v1": cfg["use_v1"],
        "use_v2": cfg["use_v2"],
        "use_retry": cfg["use_retry"],
        "refresh_day_of_month": cfg["refresh_day_of_month"],
        "count": _last_count,
        "available": sum(1 for u in _order if _cooldown.get(u, 0.0) <= now),
        "cooling_down": sum(1 for u in _order if _cooldown.get(u, 0.0) > now),
        "last_fetch_at": _last_fetch_at,
        "last_error": _last_error,
    }


# --- client pool ------------------------------------------------------------

def _rebuild_pool() -> None:
    """(Re)build one long-lived AsyncClient per proxy. httpx binds a proxy at
    the CLIENT level, so rotation means picking a different client — not a
    per-request kwarg. No-op when the list is unchanged."""
    global _order, _pool_sig, _rr_index
    sig = tuple(_proxies)
    if sig == _pool_sig:
        return

    old = dict(_pool)
    _pool.clear()
    for url in _proxies:
        try:
            _pool[url] = httpx.AsyncClient(proxy=url, timeout=_CLIENT_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            log.warning("Wayback proxy pool: skipping bad proxy: %s", e)
    _order = [u for u in _proxies if u in _pool]
    _pool_sig = tuple(_proxies)
    _rr_index = 0
    _cooldown.clear()
    log.info("Wayback proxy pool rebuilt: %d active", len(_order))

    for url, client in old.items():
        if url not in _pool:
            try:
                asyncio.create_task(client.aclose())
            except RuntimeError:
                pass


def is_enabled_for(phase: str) -> bool:
    """True when `phase` ('v1' | 'v2' | 'retry') should egress via the pool.

    Requires the master switch AND that phase's flag AND a non-empty pool —
    so a misconfigured or empty list silently degrades to direct rather than
    failing the run."""
    cfg = get_wayback_proxies_config()
    if not cfg["enabled"] or not _order:
        return False
    return bool(cfg.get(f"use_{phase}", False))


def acquire(phase: str) -> tuple[httpx.AsyncClient | None, str]:
    """Pick the next healthy proxy client for `phase`, round-robin.

    Returns `(client, egress_key)`. A `None` client means "go direct" — either
    the phase isn't proxied, or every proxy is cooling down (better to use the
    server IP than to stall). `egress_key` keys the per-IP cooldown and must be
    passed back to `report_throttle` on failure.

    Synchronous and lock-free: only ever called on the event loop, and holds
    no await."""
    global _rr_index
    if not is_enabled_for(phase):
        return None, DIRECT

    now = time.monotonic()
    n = len(_order)
    for _ in range(n):
        url = _order[_rr_index % n]
        _rr_index = (_rr_index + 1) % n
        if _cooldown.get(url, 0.0) <= now:
            client = _pool.get(url)
            if client is not None:
                return client, url
    return None, DIRECT


def report_throttle(egress_key: str) -> None:
    """Put ONE egress identity on cooldown after archive.org pushed back
    through it. No-op for `DIRECT` — the direct path keeps using the global
    reactive gate in providers/wayback.py, which is correct for a single IP."""
    if egress_key and egress_key != DIRECT:
        _cooldown[egress_key] = time.monotonic() + _COOLDOWN_SEC


def _reset_for_tests() -> None:
    global _proxies, _last_fetch_at, _last_error, _last_count
    global _order, _pool_sig, _rr_index
    _proxies = []
    _last_fetch_at = None
    _last_error = None
    _last_count = 0
    _pool.clear()
    _order = []
    _cooldown.clear()
    _pool_sig = ()
    _rr_index = 0
