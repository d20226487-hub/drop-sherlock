"""Webshare rotating-proxy source (added 2026-07-27).

Downloads the operator's Webshare "Download Proxy List" — a plain-text
`ip:port:user:pass` list, one proxy per line — and parses it into the
proxy-URL form the RDAP egress pool consumes (`http://user:pass@ip:port`).
The parsed list is held in a module-global cache; when a Webshare URL is
configured, `app_settings.get_rdap_proxies()` reads this cache INSTEAD of
the manual `availability__rdap__proxies` list (Webshare replaces it).

Refresh cadence:
  - monthly cron (main.py) on the plan's billing day — Webshare rotates the
    underlying IPs on that cycle (the operator's is the 25th);
  - a fire-and-forget fetch at boot (populates the cache on startup);
  - Settings -> "Refresh now" forces an immediate re-download.

Resilience: a failed download KEEPS the last-good cache (a transient
Webshare/network blip must not empty the pool mid-run) and is retried a
few times with backoff. Only an explicit "URL cleared" empties the cache.

Security: the download URL embeds a secret token, so it's Fernet-encrypted
at rest (see crypto._SECRET_KEY_SUFFIXES, suffix `__proxy_list_url`) and is
never echoed back to the UI — the Settings status is write-only.

Concurrency: all cache access is on the single asyncio event loop (the
fetch runs there; `get_cached_proxies()` is a plain list read), so no
locking is needed — same model as availability/proxies.py.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

import httpx

log = logging.getLogger(__name__)

# Generous read timeout — the download is small, but Webshare's endpoint can
# be sluggish. Direct egress (we're fetching the list itself, not proxying).
_FETCH_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_RETRY_MAX = 3

# Module-global cache (event-loop-confined; see module docstring).
_proxies: list[str] = []
_last_fetch_at: str | None = None   # ISO-8601 UTC of the last SUCCESSFUL fetch
_last_error: str | None = None
_last_count: int = 0


def parse_webshare_list(text: str) -> list[str]:
    """Parse Webshare's plain-text list into normalized proxy URLs.

    Each non-empty, non-comment line is one of:
      - ``ip:port:user:pass``  -> ``http://user:pass@ip:port``  (username auth)
      - ``ip:port``            -> ``http://ip:port``            (IP auth)
      - ``user:pass@ip:port``  -> kept, ``http://`` prefixed if scheme-less
    Malformed lines are skipped. Order preserved, duplicates removed so the
    round-robin stays deterministic."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        url: str | None = None
        if "@" in line:
            # Already in host-with-creds form — just ensure a scheme.
            url = line if "://" in line else f"http://{line}"
        else:
            parts = line.split(":")
            if len(parts) == 4:
                ip, port, user, pw = parts
                if ip and port:
                    url = f"http://{user}:{pw}@{ip}:{port}"
            elif len(parts) == 2:
                ip, port = parts
                if ip and port:
                    url = f"http://{ip}:{port}"
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


async def refresh() -> dict:
    """Download + parse the Webshare list into the cache. Returns `status()`.

    - No URL configured  -> clears the cache (so the pool falls back to the
      manual list cleanly) and returns.
    - Fetch/parse fails   -> KEEPS the previous cache, records `last_error`,
      after `_RETRY_MAX` retries with backoff.
    - Success             -> swaps in the new list, updates the timestamp,
      clears `last_error`."""
    global _proxies, _last_fetch_at, _last_error, _last_count
    from ..app_settings import get_webshare_proxy_list_url

    url = get_webshare_proxy_list_url()
    if not url:
        _proxies = []
        _last_count = 0
        _last_error = None
        return status()

    last_exc: Exception | None = None
    for attempt in range(_RETRY_MAX + 1):
        try:
            async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
                r = await client.get(url)
            if r.status_code >= 400:
                raise RuntimeError(
                    f"Webshare returned HTTP {r.status_code}: {r.text[:150]}"
                )
            parsed = parse_webshare_list(r.text)
            if not parsed:
                # A 2xx with an empty/garbage body is a failure, not a reason
                # to wipe a working pool — treat it like any other error.
                raise RuntimeError(
                    "Webshare list downloaded but parsed to 0 proxies"
                )
            _proxies = parsed
            _last_count = len(parsed)
            _last_fetch_at = datetime.now(timezone.utc).isoformat()
            _last_error = None
            log.info("Webshare proxy list refreshed: %d proxies", _last_count)
            return status()
        except Exception as e:  # noqa: BLE001
            last_exc = e
            if attempt < _RETRY_MAX:
                await asyncio.sleep(min(10.0, 2 ** attempt))
                continue

    _last_error = f"{type(last_exc).__name__}: {last_exc}"
    log.warning(
        "Webshare proxy refresh failed (kept %d cached proxies): %s",
        _last_count, _last_error,
    )
    return status()


async def scheduled_refresh() -> None:
    """APScheduler / boot entrypoint — wraps `refresh()` so a failure can
    never bubble into the scheduler thread. Used by the boot fetch, the
    monthly cron, and the reschedule-on-save in the settings router."""
    try:
        await refresh()
    except Exception:  # noqa: BLE001
        log.exception("scheduled Webshare proxy refresh failed")


def get_cached_proxies() -> list[str]:
    """Snapshot copy of the current parsed proxy list (never the live list)."""
    return list(_proxies)


def status() -> dict:
    """Write-only status for the UI: whether a URL is set + pool health.
    Deliberately excludes the URL itself (it embeds a secret token)."""
    from ..app_settings import get_webshare_proxy_list_url
    return {
        "configured": bool(get_webshare_proxy_list_url()),
        "count": _last_count,
        "last_fetch_at": _last_fetch_at,
        "last_error": _last_error,
    }


def _reset_for_tests() -> None:
    """Test hook — clear cached state between cases."""
    global _proxies, _last_fetch_at, _last_error, _last_count
    _proxies = []
    _last_fetch_at = None
    _last_error = None
    _last_count = 0
