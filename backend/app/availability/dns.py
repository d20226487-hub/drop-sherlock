"""DNS pre-check — fast, free, unlimited.

Asks the resolver for NS records. NXDOMAIN + no NS = strong signal of
"not registered" (~95% reliable on gTLDs). Any other answer means we
can't tell from DNS alone and the cascade falls through to RDAP for
authoritative state. False positives (parked domains with NS records
that have actually dropped) are rare and caught by the next provider.

Run with a tight timeout — DNS should resolve in 10–50ms on a local
resolver. Anything past 2s is treated as a failure.
"""
from __future__ import annotations

import asyncio
import time

import dns.asyncresolver
import dns.exception
import dns.resolver

from .common import (
    ERR_CAT_DNS,
    ERR_CAT_NETWORK,
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_UNKNOWN,
)


# Module-level resolver — dnspython caches NS lookups internally;
# instantiating per call would burn that cache. Timeout/lifetime tuned
# tight so a hung resolver doesn't hold up a batch.
_resolver = dns.asyncresolver.Resolver()
_resolver.timeout = 1.5
_resolver.lifetime = 2.0


async def check(domain: str) -> ProviderResult:
    """One DNS check. Pure async — no DB writes."""
    started = time.monotonic()
    try:
        await _resolver.resolve(domain, "NS")
        # NS records exist → likely registered, but not authoritative.
        # Caller's cascade should continue to RDAP.
        return ProviderResult(
            provider="dns",
            status=STATUS_UNKNOWN,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
    except dns.resolver.NXDOMAIN:
        # Strong signal — domain doesn't exist in DNS at all.
        return ProviderResult(
            provider="dns",
            status=STATUS_AVAILABLE,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
    except dns.resolver.NoAnswer:
        # Zone exists but no NS records (rare — TLD itself returned
        # without delegation). Caller continues.
        return ProviderResult(
            provider="dns",
            status=STATUS_UNKNOWN,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
    except (dns.exception.Timeout, asyncio.TimeoutError) as e:
        return ProviderResult(
            provider="dns",
            status=STATUS_ERROR,
            latency_ms=int((time.monotonic() - started) * 1000),
            error_message=f"DNS timeout: {e}",
            error_category=ERR_CAT_DNS,
        )
    except Exception as e:  # noqa: BLE001
        return ProviderResult(
            provider="dns",
            status=STATUS_ERROR,
            latency_ms=int((time.monotonic() - started) * 1000),
            error_message=f"DNS error: {e}",
            error_category=ERR_CAT_NETWORK,
        )
