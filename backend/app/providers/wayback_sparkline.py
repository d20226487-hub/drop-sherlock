"""Wayback Sparkline endpoint client.

The undocumented `__wb/sparkline` endpoint backs archive.org's calendar-
view sparkline chart. Returns exact total capture counts for a target
URL plus a per-year breakdown in ~0.4–1.0s — much faster than the
documented CDX search path (limit-bounded, collapse-aware, often >10s
for high-volume domains).

Endpoint shape (verified 2026-05-23 against live responses):

    GET https://web.archive.org/__wb/sparkline
        ?output=json
        &url={target}            # full URL with scheme; trailing slash OK
        &collection=web

Response (HTTP 200):
    {
      "years": {
        "2010": [0, 0, ..., 1, ...],   # 12 ints (one per month)
        "2011": [...],
        ...
      },
      "first_ts": "20100315120000",
      "last_ts": "20240801093344"
    }

`total_captures = sum(sum(months) for months in years.values())`.

Critical: the endpoint requires browser-ish headers — without them it
returns HTTP 498 (CloudFront-custom) wrapping a 404 body. The required
headers reproduced empirically:
  - User-Agent: any non-default UA string
  - Accept: includes `application/json`
  - Referer: starts with https://web.archive.org/
  - X-Requested-With: XMLHttpRequest

Drop any one and you get the 498. The headers are sent on every call
from `_DEFAULT_HEADERS` below.

Rate limits live under the `wayback_sparkline` row in app_settings —
independent of the main `wayback` limiter so a 100k sparkline batch
doesn't starve quality-pillar wayback fetches.
"""
from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass
from typing import Any

import httpx

from ..limits import limit

log = logging.getLogger(__name__)

_API_BASE = "https://web.archive.org/__wb/sparkline"
_TIMEOUT_SECONDS = 30.0


# --- Global 429 cooldown gate (2026-05-23) ---------------------------------
#
# archive.org throttles by IP, not per-request, and the throttle stays
# armed for SEVERAL MINUTES once tripped. Without this gate, all N
# concurrent workers keep firing during the throttle window — every
# retry resets archive.org's clock + wastes a slot.
#
# State is module-level so every coroutine pulling sparkline shares the
# same gate. When one worker sees a 429, it sets `_cooldown_until` to
# `now + _COOLDOWN_SECONDS`; every other worker (including the one that
# triggered it) sleeps until that timestamp before making its next
# request.
#
# Concretely the gate sleeps inside `fetch_sparkline_count` BEFORE
# acquiring the rate-limit slot — so the rate-limit bucket doesn't
# refill tokens uselessly during the cooldown window. After the
# cooldown clears, normal token-bucket pacing resumes.
#
# `_COOLDOWN_SECONDS = 300` (5 min) — calibrated 2026-05-23 after a
# longer sustained-throttle observation. archive.org's sparkline
# throttle window for repeat 429-triggerers escalates well past the
# initial 60-90s when multiple 429s land in rapid succession (jobs
# can rack up dozens before the gate first fires). 300s gives the
# IP-level throttle enough time to roll forward even after extended
# stress. Tune down once we have confidence the burst=1 + concurrency=1
# defaults keep us below archive.org's threshold from a cold start.
_COOLDOWN_SECONDS = 300.0
_cooldown_lock = asyncio.Lock()
_cooldown_until: float = 0.0  # event-loop monotonic time


async def _wait_for_cooldown() -> None:
    """Block until any active 429 cooldown clears. Cheap fast-path when
    the gate isn't armed (a single monotonic-time comparison)."""
    while True:
        loop = asyncio.get_event_loop()
        now = loop.time()
        if now >= _cooldown_until:
            return
        # Sleep outside the lock so concurrent waiters wake without
        # serializing through the gate.
        await asyncio.sleep(_cooldown_until - now)


async def _arm_cooldown(reason: str) -> None:
    """Set `_cooldown_until` to now + _COOLDOWN_SECONDS, but only if
    the current value is in the past. Without the check, every 429
    seen by a sibling coroutine would extend the cooldown — fine
    behaviour but harder to reason about; this caps the window."""
    global _cooldown_until
    async with _cooldown_lock:
        loop = asyncio.get_event_loop()
        now = loop.time()
        if _cooldown_until <= now:
            _cooldown_until = now + _COOLDOWN_SECONDS
            log.warning(
                "sparkline 429 cooldown armed for %.0fs (%s)",
                _COOLDOWN_SECONDS, reason,
            )

# Mandatory headers — see module docstring for why each one is required.
# Pulled into a module-level constant so the request shape stays identical
# on retries (sparkline's bot detection is touchy).
_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 drop-sherlock"
    ),
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Referer": "https://web.archive.org/",
    "X-Requested-With": "XMLHttpRequest",
}


class WaybackSparklineError(Exception):
    """Raised on terminal sparkline failures (retries exhausted, auth
    error, malformed response). The runner catches this and records the
    error on the per-domain result row — no special handling needed
    beyond the existing per-domain failure path."""


@dataclass
class SparklineCount:
    """Parsed sparkline result for one domain.

    `snapshot_count` is the sum across every year+month in the response.
    `years_with_data` counts distinct years with at least one capture.
    `first_year` / `last_year` are derived from years keys (sparkline
    also returns first_ts/last_ts but those are full timestamps; year
    is what the operator filters on).

    All fields are None on zero-capture domains EXCEPT snapshot_count
    which is 0 — distinguishes "fetched, got nothing" from "didn't
    fetch yet" cleanly on the runner's result row."""

    snapshot_count: int
    first_year: int | None
    last_year: int | None
    years_with_data: int


def _normalize_url(domain: str) -> str:
    """Sparkline accepts both bare hosts and full URLs; we send the
    https://-prefixed form for consistency and let the upstream
    normalize. Drop trailing whitespace + any user-pasted scheme,
    then re-add https:// + trailing slash.

    The endpoint's URL canonicalization is host-level (all paths
    aggregated), which is exactly what we want — the operator types
    `example.com`, we return total captures across every path."""
    s = domain.strip().lower()
    for prefix in ("https://", "http://"):
        if s.startswith(prefix):
            s = s[len(prefix):]
    s = s.split("/", 1)[0]
    if not s:
        return ""
    return f"https://{s}/"


def _parse_sparkline(body: dict[str, Any]) -> SparklineCount:
    """Sum captures across the years map. Defensive: any non-list value
    or non-int element contributes 0 so a malformed response doesn't
    throw — the runner sees a 0-count answer with no error, which the
    caller can spot via elapsed_ms-distribution analytics if needed."""
    years_raw = body.get("years")
    if not isinstance(years_raw, dict):
        return SparklineCount(0, None, None, 0)

    total = 0
    years_with_data: list[int] = []
    for year_str, months in years_raw.items():
        if not isinstance(months, list):
            continue
        year_sum = 0
        for m in months:
            if isinstance(m, int) and m > 0:
                year_sum += m
        if year_sum > 0:
            total += year_sum
            try:
                years_with_data.append(int(year_str))
            except ValueError:
                # Sparkline shouldn't emit non-int year keys, but
                # defensively skip if it ever does.
                continue

    if not years_with_data:
        return SparklineCount(0, None, None, 0)
    return SparklineCount(
        snapshot_count=total,
        first_year=min(years_with_data),
        last_year=max(years_with_data),
        years_with_data=len(years_with_data),
    )


def _backoff(attempt: int) -> float:
    """Jittered exponential backoff. Same shape as the Wayback CDX +
    WhoisFreaks retry loops so the system has one mental model for
    "transient failure → sleep this long, then try again". Cap at 30s
    so a sustained outage on archive.org can't park a 100k batch
    indefinitely — after retry_max attempts the domain just gets
    marked error and the runner moves on."""
    base = min(30.0, 2 ** attempt)
    jitter = random.uniform(0.75, 1.25)
    return base * jitter


async def fetch_sparkline_count(
    domain: str,
    *,
    client: httpx.AsyncClient | None = None,
    retry_max: int | None = None,
) -> SparklineCount:
    """Fetch + parse the sparkline JSON for one domain.

    Gated through the `wayback_sparkline` rate-limit row. Retries on
    transient HTTP / network errors with jittered backoff. Reuses the
    caller-supplied `httpx.AsyncClient` when provided (the runner shares
    one client across the whole job to avoid TCP-handshake overhead at
    100k scale).

    Raises `WaybackSparklineError` after retries exhausted. Caller is
    expected to translate that to a per-domain `error` result row, not
    abort the batch.
    """
    target = _normalize_url(domain)
    if not target:
        raise WaybackSparklineError("empty domain after normalization")

    # Read retry budget from rate-limit settings at call time — same
    # pattern as the wayback CDX provider so a Settings change picks up
    # on the next call.
    if retry_max is None:
        try:
            from ..app_settings import get_rate_limits
            retry_max = int(
                get_rate_limits("wayback_sparkline").get("retry_max", 3)
            )
        except Exception:  # noqa: BLE001
            retry_max = 3

    params = {"output": "json", "url": target, "collection": "web"}
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=_TIMEOUT_SECONDS,
            headers=_DEFAULT_HEADERS,
        )
    try:
        last_err: Exception | None = None
        last_status: int | None = None
        last_body: str = ""
        for attempt in range(retry_max + 1):
            # Global 429 cooldown gate — block if any sibling coroutine
            # has armed the cooldown. Cheap fast-path when idle; sleeps
            # until the cooldown timestamp passes when armed. Sits
            # OUTSIDE the rate-limit slot so the bucket can refill
            # tokens during the cooldown without spending them.
            await _wait_for_cooldown()
            try:
                async with limit("wayback_sparkline"):
                    # Wrap in the rate-limit gate so every retry pays
                    # the spacing cost — without this a burst of 4xxs
                    # would all retry at once and re-trigger whatever
                    # signal caused the original failure.
                    r = await client.get(
                        _API_BASE,
                        params=params,
                        headers=_DEFAULT_HEADERS,
                    )
            except (httpx.HTTPError, ValueError) as e:
                last_err = e
                if attempt < retry_max:
                    log.info(
                        "sparkline network error on %s (attempt %d/%d): "
                        "%s — retrying",
                        domain, attempt + 1, retry_max + 1, e,
                    )
                    await asyncio.sleep(_backoff(attempt))
                    continue
                raise WaybackSparklineError(
                    f"sparkline fetch failed after {retry_max + 1} "
                    f"attempts: {type(e).__name__}: {e}"
                ) from e

            # Sparkline returns 498 (custom) wrapping a 404 when the
            # headers don't satisfy its bot check. Should never happen
            # with _DEFAULT_HEADERS, but treat as terminal (retrying
            # won't help if the headers themselves are wrong).
            if r.status_code == 498:
                raise WaybackSparklineError(
                    "sparkline rejected request — headers may have "
                    "drifted from what the endpoint requires "
                    "(User-Agent / Referer / X-Requested-With)"
                )
            # 429 / 5xx → transient, retry.
            if r.status_code == 429 or 500 <= r.status_code < 600:
                last_status = r.status_code
                last_body = r.text[:200] if r.text else ""
                # 429 specifically: arm the global cooldown so EVERY
                # worker (including this one for its next attempt)
                # backs off for `_COOLDOWN_SECONDS`. archive.org's
                # IP-level throttle stays armed for minutes once
                # tripped; per-request retries every 30s just keep
                # the clock running.
                if r.status_code == 429:
                    await _arm_cooldown(
                        f"domain={domain} attempt={attempt + 1}",
                    )
                if attempt < retry_max:
                    log.info(
                        "sparkline HTTP %d on %s (attempt %d/%d) — "
                        "retrying after backoff",
                        r.status_code, domain, attempt + 1, retry_max + 1,
                    )
                    await asyncio.sleep(_backoff(attempt))
                    continue
                raise WaybackSparklineError(
                    f"sparkline returned {r.status_code} after "
                    f"{retry_max + 1} attempts: {last_body}"
                )
            if r.status_code != 200:
                raise WaybackSparklineError(
                    f"sparkline HTTP {r.status_code}: {r.text[:200]}"
                )

            try:
                body = r.json()
            except ValueError as e:
                last_err = e
                if attempt < retry_max:
                    await asyncio.sleep(_backoff(attempt))
                    continue
                raise WaybackSparklineError(
                    f"sparkline non-JSON body: {r.text[:200]}"
                ) from e

            return _parse_sparkline(body)

        # Defensive — loop exits via return/raise/continue.
        raise WaybackSparklineError(
            f"sparkline unreachable: retry exhausted "
            f"(last_status={last_status}, last_err={last_err!r})"
        )
    finally:
        if own_client:
            await client.aclose()
