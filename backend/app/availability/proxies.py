"""RDAP egress proxy pool (added 2026-06-15).

The gTLD/ccTLD RDAP registries throttle by SOURCE IP: a bulk availability
run from one server IP degrades from ~0.8s/lookup to 5-21s with rising
timeouts as the registries tarpit the IP. Routing RDAP through a rotating
pool of operator-supplied proxies spreads the lookups across many IPs so
no single one trips the throttle.

httpx binds a proxy at the CLIENT level (not per request) and 0.28 uses
the singular ``proxy=`` kwarg, so the pool is one long-lived AsyncClient
per proxy URL, picked round-robin per RDAP domain lookup. A proxy that
fails at the transport layer (dead/blocked) is put on a short cooldown
and skipped; when every proxy is cooling down — or none are configured —
callers fall back to the direct client (current behavior).

Scope: RDAP only. WhoisFreaks is a paid API billed to the account and is
NOT IP-throttled, so it always runs direct.

Lifecycle: the pool is module-global and rebuilt lazily when the
configured list changes (re-checked at most every `_REFRESH_TTL`s, so a
high-volume run doesn't re-read the setting on every lookup). All access
is on the single asyncio event loop, so no locking is needed.
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

from ..app_settings import get_rdap_proxies

log = logging.getLogger(__name__)

# Backstop timeout for the proxy clients. The RDAP domain GET passes its
# own (tighter) per-request timeout, so this only bounds a pathological
# proxy that accepts the connection but never responds.
_CLIENT_TIMEOUT = httpx.Timeout(5.0)
# How long a transport-failed proxy is skipped before it's retried.
_COOLDOWN_SEC = 60.0
# Re-read the config (a DB key lookup) at most this often.
_REFRESH_TTL = 15.0

_pool: dict[str, httpx.AsyncClient] = {}
_order: list[str] = []
_cooldown: dict[str, float] = {}
_rr_index = 0
_config_sig: tuple[str, ...] = ()
_last_refresh = 0.0


def _refresh() -> None:
    """Rebuild the client pool when the configured proxy list changes.
    Cheap no-op between refreshes (TTL-gated) and when the list is
    unchanged."""
    global _order, _config_sig, _last_refresh, _rr_index
    now = time.monotonic()
    if now - _last_refresh < _REFRESH_TTL:
        return
    _last_refresh = now
    proxies = get_rdap_proxies()
    sig = tuple(proxies)
    if sig == _config_sig:
        return

    # Config changed — build fresh clients, retire the old ones.
    old = dict(_pool)
    _pool.clear()
    for url in proxies:
        try:
            _pool[url] = httpx.AsyncClient(proxy=url, timeout=_CLIENT_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            log.warning("RDAP proxy pool: skipping bad proxy %r: %s", url, e)
    _order = [u for u in proxies if u in _pool]
    _config_sig = tuple(_order)
    _rr_index = 0
    _cooldown.clear()
    log.info("RDAP proxy pool rebuilt: %d proxies active", len(_order))

    # Close clients we no longer use (fire-and-forget; we're on the loop).
    for url, client in old.items():
        if url not in _pool:
            try:
                asyncio.create_task(client.aclose())
            except RuntimeError:
                pass


def acquire_rdap_client(
    direct: httpx.AsyncClient,
) -> tuple[httpx.AsyncClient, str | None]:
    """Pick the next healthy proxy client (round-robin), or fall back to
    `direct`. Returns (client, proxy_url | None) — `None` means the direct
    client was returned (no proxies configured, or all are cooling down).
    Synchronous + lock-free: safe because it's only called on the event
    loop and holds no await."""
    global _rr_index
    _refresh()
    if not _order:
        return direct, None
    now = time.monotonic()
    n = len(_order)
    for _ in range(n):
        url = _order[_rr_index % n]
        _rr_index = (_rr_index + 1) % n
        if _cooldown.get(url, 0.0) <= now:
            client = _pool.get(url)
            if client is not None:
                return client, url
    # Every proxy is in cooldown — better to go direct than to wait.
    return direct, None


def report_proxy_failure(proxy_url: str | None) -> None:
    """Mark `proxy_url` as bad for a cooldown window so the rotation skips
    it. No-op for the direct client (`None`)."""
    if proxy_url:
        _cooldown[proxy_url] = time.monotonic() + _COOLDOWN_SEC


def _reset_for_tests() -> None:
    """Test hook — clear cached state so a test can drive the rotation
    deterministically without TTL/sig carryover."""
    global _order, _config_sig, _last_refresh, _rr_index
    _pool.clear()
    _order = []
    _cooldown.clear()
    _config_sig = ()
    _last_refresh = 0.0
    _rr_index = 0
