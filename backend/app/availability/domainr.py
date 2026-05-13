"""Domainr (via RapidAPI Basic tier) — optional commercial backup
for TLDs RDAP doesn't reach.

Endpoint: GET https://domainr.p.rapidapi.com/v2/status?domain=<d>
Auth: X-RapidAPI-Key + X-RapidAPI-Host headers.

Returns a `summary` like "active" (registered), "undelegated" (no
nameservers, often available), "inactive" (registered but not in DNS
yet), "marketed" (for-sale), "parked", "tld" (the TLD root), etc.

Mapping to our taxonomy:
  - 'active' / 'inactive' / 'parked' / 'marketed' → registered
  - 'undelegated' / 'unknown' (NXDOMAIN-equivalent) → available
  - Anything else → unknown (let cascade continue)
"""
from __future__ import annotations

import json
import time

import httpx

from ..app_settings import get_domainr_api_key
from .common import (
    ERR_CAT_DOMAINR,
    ERR_CAT_NETWORK,
    ERR_CAT_PARSE,
    ERR_CAT_QUOTA,
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    STATUS_UNKNOWN,
)


DOMAINR_HOST = "domainr.p.rapidapi.com"
DOMAINR_URL = f"https://{DOMAINR_HOST}/v2/status"

_REGISTERED_SUMMARIES = frozenset({
    "active", "inactive", "parked", "marketed", "reserved", "premium",
    "deleting", "transferable", "disallowed", "expiring", "suffix",
})
_AVAILABLE_SUMMARIES = frozenset({
    "undelegated", "available",
})


async def check(domain: str, client: httpx.AsyncClient | None = None) -> ProviderResult:
    started = time.monotonic()
    api_key = get_domainr_api_key()
    if not api_key:
        return ProviderResult(
            provider="domainr",
            status=STATUS_ERROR,
            latency_ms=0,
            error_message="Domainr API key not configured",
            error_category=ERR_CAT_DOMAINR,
        )

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=10.0)

    try:
        try:
            r = await client.get(
                DOMAINR_URL,
                params={"domain": domain},
                headers={
                    "X-RapidAPI-Key": api_key,
                    "X-RapidAPI-Host": DOMAINR_HOST,
                },
            )
        except httpx.TimeoutException as e:
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"Domainr timeout: {e}",
                error_category=ERR_CAT_NETWORK,
            )
        except httpx.HTTPError as e:
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"Domainr transport: {e}",
                error_category=ERR_CAT_NETWORK,
            )

        latency = int((time.monotonic() - started) * 1000)
        if r.status_code == 429:
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message="Domainr rate-limited / quota exhausted",
                error_category=ERR_CAT_QUOTA,
            )
        if r.status_code == 401 or r.status_code == 403:
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"Domainr auth failed ({r.status_code})",
                error_category=ERR_CAT_DOMAINR,
            )
        if r.status_code != 200:
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"Domainr HTTP {r.status_code}",
                error_category=ERR_CAT_DOMAINR,
            )
        try:
            body = r.json()
        except (json.JSONDecodeError, ValueError) as e:
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"Domainr parse: {e}",
                error_category=ERR_CAT_PARSE,
            )
        # `status` is an array; we want the entry whose `domain` matches.
        status_list = body.get("status") or []
        summary = ""
        for entry in status_list:
            if isinstance(entry, dict) and entry.get("domain", "").lower() == domain.lower():
                summary = (entry.get("summary") or "").lower()
                break
        if not summary and status_list and isinstance(status_list[0], dict):
            summary = (status_list[0].get("summary") or "").lower()
        if summary in _AVAILABLE_SUMMARIES:
            return ProviderResult(
                provider="domainr",
                status=STATUS_AVAILABLE,
                latency_ms=latency,
                raw_response=json.dumps(body)[:4000],
            )
        if summary in _REGISTERED_SUMMARIES:
            return ProviderResult(
                provider="domainr",
                status=STATUS_REGISTERED,
                latency_ms=latency,
                raw_response=json.dumps(body)[:4000],
            )
        return ProviderResult(
            provider="domainr",
            status=STATUS_UNKNOWN,
            latency_ms=latency,
            error_message=f"Domainr summary not actionable: {summary or '<empty>'}",
            raw_response=json.dumps(body)[:4000],
        )
    finally:
        if own_client:
            await client.aclose()
