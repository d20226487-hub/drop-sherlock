"""Domainr via Fastly's Domain Research API — optional commercial backup
for TLDs RDAP doesn't reach (e.g. ccTLDs like .kz).

Switched from the RapidAPI flavor to Fastly-native on 2026-06-08: Domainr
is a Fastly product, and the operator authenticates with a Fastly API
token (created in the Fastly control panel), not a RapidAPI key.

Endpoint: GET https://api.fastly.com/domain-management/v1/tools/status?domain=<d>
Auth:     Fastly-Key: <fastly_api_token>  (standard Fastly API auth header)
Docs:     https://docs.fastly.com/products/domain-research-api
          https://www.fastly.com/documentation/reference/api/domain-management/domain-research/

The Domain Research API product must be enabled on the Fastly account, and
the token needs at least read access (global:read is sufficient — status
is a GET). A precise check is the default; pass scope=estimate for a
cheaper, less-accurate result (we use precise — buy decisions need it).

Response JSON (single object): {domain, status, tags, zone, scope, offers}.
`status` is a SPACE-DELIMITED list of status tokens in INCREASING order of
precedence — the right-most token is the most important. Token meanings
(per Domainr docs):
  available : inactive, undelegated
  taken     : active, parked, marketed, expiring, deleting, priced,
              transferable, premium
  blocked   : pending, disallowed, claimed, reserved, dpml, invalid
              (can't be registered by us → treated as "not available")
  n/a       : unknown, suffix, zone, tld → not decisive → cascade continues
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


# Fastly Domain Research API — status (availability) endpoint.
DOMAINR_URL = "https://api.fastly.com/domain-management/v1/tools/status"

# Tokens that mean the domain can be registered right now.
_AVAILABLE_STATUSES = frozenset({"inactive", "undelegated"})
# Tokens that mean the domain is NOT available (taken/aftermarket, or
# blocked by the registry/ICANN). We collapse "blocked" into registered
# because the actionable answer for a drop hunter is the same: not free.
_REGISTERED_STATUSES = frozenset({
    "active", "parked", "marketed", "expiring", "deleting",
    "priced", "transferable", "premium",
    "pending", "disallowed", "claimed", "reserved", "dpml", "invalid",
})
# "unknown" / "suffix" / "zone" / "tld" are not decisive → STATUS_UNKNOWN
# so the cascade falls through to the next provider (e.g. port-43 WHOIS).


def _resolve_status(status_str: str) -> str:
    """Map Domainr's space-delimited `status` string to our taxonomy.

    Honors Domainr precedence: the right-most token wins, so we scan from
    the end and return on the first decisive (available/registered) token.
    A status with only non-decisive tokens (unknown/suffix/zone/tld, or an
    empty string) yields STATUS_UNKNOWN."""
    tokens = status_str.lower().split()
    for tok in reversed(tokens):
        if tok in _AVAILABLE_STATUSES:
            return STATUS_AVAILABLE
        if tok in _REGISTERED_STATUSES:
            return STATUS_REGISTERED
    return STATUS_UNKNOWN


async def check(domain: str, client: httpx.AsyncClient | None = None) -> ProviderResult:
    started = time.monotonic()
    api_key = get_domainr_api_key()
    if not api_key:
        return ProviderResult(
            provider="domainr",
            status=STATUS_ERROR,
            latency_ms=0,
            error_message="Domainr (Fastly) API token not configured",
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
                    "Fastly-Key": api_key,
                    "Accept": "application/json",
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
        if r.status_code in (401, 403):
            # 401 = bad/expired token; 403 = token lacks access OR the
            # Domain Research API product isn't enabled on the account.
            return ProviderResult(
                provider="domainr",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=(
                    f"Domainr (Fastly) auth failed ({r.status_code}) — check the "
                    "Fastly API token and that the Domain Research API is enabled"
                ),
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
        # The status endpoint returns a single object. Be defensive: some
        # Fastly list-style endpoints wrap results in {"data": [...]}, so
        # accept either shape and pull the matching domain's status.
        record = body
        if isinstance(body, dict) and "status" not in body:
            data = body.get("data")
            if isinstance(data, list):
                record = next(
                    (
                        d for d in data
                        if isinstance(d, dict)
                        and str(d.get("domain", "")).lower() == domain.lower()
                    ),
                    data[0] if data and isinstance(data[0], dict) else {},
                )
        status_str = ""
        if isinstance(record, dict):
            status_str = str(record.get("status") or "")
        resolved = _resolve_status(status_str)
        if resolved == STATUS_UNKNOWN:
            return ProviderResult(
                provider="domainr",
                status=STATUS_UNKNOWN,
                latency_ms=latency,
                error_message=f"Domainr status not actionable: {status_str or '<empty>'}",
                raw_response=json.dumps(body)[:4000],
            )
        return ProviderResult(
            provider="domainr",
            status=resolved,
            latency_ms=latency,
            raw_response=json.dumps(body)[:4000],
        )
    finally:
        if own_client:
            await client.aclose()
