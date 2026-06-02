"""Per-provider rate limiting.

Two knobs are applied per call:
- **Token bucket** (RPM) — enforces the "no more than N requests per 60s"
  budget. Tokens refill smoothly across the minute, so a burst can use the
  full RPM allowance up to bucket capacity but a sustained workload settles
  at exactly the configured rate.
- **Concurrency semaphore** (max_concurrent) — caps how many requests are
  in-flight to the provider at once. Independent of the bucket: even if you
  have plenty of tokens, the semaphore prevents us from saturating the
  upstream with fan-out.

Per-provider limiters are lazily created on first use and cached for the
process lifetime; on settings change we invalidate the cache so the next
acquire picks up the new RPM/concurrency without a process restart."""
from __future__ import annotations

import asyncio
import time

from .app_settings import get_rate_limits


class _TokenBucket:
    """Smooth refill at `rpm/60` tokens/sec with a configurable burst.

    `burst` is the bucket capacity — the maximum number of tokens that can
    accumulate while idle, i.e. how many requests can fire back-to-back
    after a quiet period. It defaults to `rpm` (legacy "burst-up-to-the-
    minute" behavior, fine for providers that publish their rate as a
    rolling per-minute window). Providers with strict per-minute paid-tier
    caps (WhoisFreaks is the canonical example) should pass `burst=1` so
    requests get spaced exactly `60/rpm` seconds apart — no headroom for
    a burst that exceeds the published ceiling.

    Single-process — fine for our single-uvicorn-worker setup.
    """

    def __init__(self, rpm: int, burst: int | None = None):
        self.capacity = max(1, burst if burst is not None else rpm)
        self.refill_per_sec = max(1, rpm) / 60.0
        self.tokens = float(self.capacity)
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                now = time.monotonic()
                elapsed = now - self.updated
                self.tokens = min(
                    self.capacity, self.tokens + elapsed * self.refill_per_sec
                )
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                deficit = 1 - self.tokens
                wait = deficit / self.refill_per_sec
            # Sleep outside the lock so siblings can recompute when the next
            # token becomes available.
            await asyncio.sleep(wait)


class _ProviderLimiter:
    def __init__(self, rpm: int, max_concurrent: int, burst: int | None = None):
        self.bucket = _TokenBucket(rpm, burst=burst)
        self.sem = asyncio.Semaphore(max(1, max_concurrent))
        self.rpm = rpm
        self.max_concurrent = max_concurrent
        self.burst = self.bucket.capacity


# Providers that enforce strict per-minute caps — no burst is safe.
# The bucket's capacity gets pinned to 1 token, so a user-configured
# rpm=N is realized as "one request every 60/N seconds" rather than
# "N back-to-back, then idle".
#
# Members:
#   - whoisfreaks: paid tier with hard per-minute caps (5/min seen).
#     Bursting trips 429 even when sustained rate is well under quota.
#   - wayback_sparkline (added 2026-05-23): archive.org's __wb/sparkline
#     endpoint. Live calibration on Job 2 showed bursts of 8+ concurrent
#     within the first second hit 429s before the rate-limiter's natural
#     pacing took over — bucket capacity = rpm meant we burned the
#     entire minute's budget in <1s. With burst=1, requests space at
#     60/rpm seconds (e.g. rpm=180 → 0.33s apart) and stay under the
#     hidden archive.org window.
_STRICT_BURST_PROVIDERS: frozenset[str] = frozenset(
    {"whoisfreaks", "wayback_sparkline"},
)


# Cache keyed by provider name. Invalidate by deleting the entry; the next
# get_limiter() call rebuilds with current settings.
_LIMITERS: dict[str, _ProviderLimiter] = {}


def _burst_for(provider: str, rpm: int) -> int:
    return 1 if provider in _STRICT_BURST_PROVIDERS else max(1, rpm)


def get_limiter(provider: str) -> _ProviderLimiter:
    cached = _LIMITERS.get(provider)
    rl = get_rate_limits(provider)
    desired_burst = _burst_for(provider, rl["rpm"])
    # If the configured values changed (user updated Settings), rebuild so
    # we don't run on stale capacity. Cheap: just reallocates a bucket and
    # semaphore. Side note — a Semaphore that's been acquired can't safely
    # be replaced if calls are mid-flight, but acquires through the OLD
    # limiter just keep it alive until they release. New acquires after this
    # rebuild use the new semaphore.
    if (
        cached
        and cached.rpm == rl["rpm"]
        and cached.max_concurrent == rl["max_concurrent"]
        and cached.burst == desired_burst
    ):
        return cached
    fresh = _ProviderLimiter(
        rpm=rl["rpm"],
        max_concurrent=rl["max_concurrent"],
        burst=desired_burst,
    )
    _LIMITERS[provider] = fresh
    return fresh


class limit:
    """Async context manager — acquires the semaphore + token, releases the
    semaphore on exit. Token is consumed, no release.

        async with limit("ahrefs"):
            r = await client.get(...)

    Defensive guarantees (hardened 2026-05-09 after a wayback_classify
    pause+resume deadlock — see project memory):
    1. **Pinned-limiter release.** The instance acquired from in
       `__aenter__` is stored on `self` and reused in `__aexit__`. If
       rate-limit Settings change between enter and exit, `get_limiter()`
       rebuilds and returns a NEW limiter — releasing on that one would
       leak the original semaphore slot AND over-release the new
       semaphore. Pinning the limiter eliminates both bugs.
    2. **CancelledError safety.** If the wrapped body is cancelled,
       Python's async-with semantics still call `__aexit__`. The release
       there has no `await` points, so it can't itself be re-cancelled.
       If cancellation hits inside the bucket-acquire (after we already
       hold the semaphore), the `try/finally` in `__aenter__` releases
       it before re-raising. If cancellation hits during the initial
       `sem.acquire()` await, no slot was ever held — nothing to release.
    3. **Idempotent on double-exit.** `__aexit__` clears `self._lim`
       before releasing, so any pathological re-entry / double-exit
       (e.g. a caller stashing the context manager) won't double-release."""

    def __init__(self, provider: str):
        self.provider = provider
        # Hold the SAME limiter instance from acquire-time through release-
        # time, so a rate-limit settings change doesn't make us release on
        # a different semaphore than we acquired from.
        self._lim: _ProviderLimiter | None = None

    async def __aenter__(self):
        lim = get_limiter(self.provider)
        await lim.sem.acquire()
        # Pin the limiter only AFTER the acquire returns. If sem.acquire()
        # was cancelled, no slot was held and `self._lim` stays None →
        # `__aexit__` becomes a no-op (correct).
        self._lim = lim
        try:
            await lim.bucket.acquire()
        except (Exception, asyncio.CancelledError):
            # Bucket-acquire failed — release the semaphore we DID acquire
            # on the SAME limiter, then drop the pin and re-raise.
            # `asyncio.CancelledError` is listed explicitly because in
            # Python 3.8+ it inherits from BaseException, not Exception,
            # and we MUST clean up on cancellation. We deliberately do
            # NOT catch the other BaseException subtypes (KeyboardInterrupt,
            # SystemExit) — they signal interpreter shutdown and should
            # short-circuit cleanup. The inner try/finally on the release
            # is paranoid — `asyncio.Semaphore.release()` is documented as
            # never raising for over-release, but if we somehow hit a
            # custom subclass that does, we still want `_lim=None` so a
            # later __aexit__ doesn't double-release.
            try:
                lim.sem.release()
            finally:
                self._lim = None
            raise
        return self

    async def __aexit__(self, exc_type, exc, tb):
        # Best-effort release of the SAME limiter we acquired from. Clears
        # `_lim` first so any double-exit (pathological) is a no-op rather
        # than a double-release. No `await` here — Python's cancellation
        # semantics guarantee this body runs to completion even when the
        # wrapped block raised CancelledError.
        lim = self._lim
        self._lim = None
        if lim is not None:
            lim.sem.release()
