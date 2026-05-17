"""RDAP — the modern WHOIS replacement, HTTPS+JSON, free, no API key.

Per-TLD server discovery via ICANN's public bootstrap file (cached
in-process; refreshed once per process lifetime).

Status mapping:
  - HTTP 200 with valid body → STATUS_REGISTERED (extract registrar +
    expires_on from `entities[].roles/vcardArray` and `events[].eventAction
    == 'expiration'`).
  - HTTP 404 → STATUS_AVAILABLE (the registry explicitly says "no
    such object").
  - HTTP 429 / 503 → STATUS_ERROR with error_category='quota' or
    'rdap'.
  - Anything else / network errors → STATUS_ERROR.

Verisign (.com/.net) is generous with rate limits but throttles
aggressively above ~10/s. Defaults in app_settings clamp at 3/s.
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime
from typing import Any

import httpx

from .common import (
    ERR_CAT_NETWORK,
    ERR_CAT_PARSE,
    ERR_CAT_QUOTA,
    ERR_CAT_RDAP,
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    STATUS_UNKNOWN,
)


IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
_bootstrap_cache: dict[str, str] | None = None
_bootstrap_fetched_at: float = 0.0
_BOOTSTRAP_TTL_SEC = 86400.0  # refresh once per day


async def _get_rdap_server(domain: str, client: httpx.AsyncClient) -> str | None:
    """Resolve the RDAP base URL for a domain's TLD. Returns None when
    no RDAP server is registered for the TLD (rare for the gTLDs the
    user said they target; some ccTLDs lack RDAP)."""
    global _bootstrap_cache, _bootstrap_fetched_at
    now = time.monotonic()
    if (
        _bootstrap_cache is None
        or now - _bootstrap_fetched_at > _BOOTSTRAP_TTL_SEC
    ):
        try:
            r = await client.get(IANA_BOOTSTRAP_URL, timeout=10.0)
            r.raise_for_status()
            data = r.json()
        except Exception:  # noqa: BLE001
            # Bootstrap fetch failed — fall back to a minimal hardcoded
            # map for the common gTLDs so .com/.net/.org keep working.
            _bootstrap_cache = {
                "com": "https://rdap.verisign.com/com/v1",
                "net": "https://rdap.verisign.com/net/v1",
                "org": "https://rdap.publicinterestregistry.org/rdap",
            }
            _bootstrap_fetched_at = now
        else:
            mapping: dict[str, str] = {}
            for entry in data.get("services", []):
                # entry shape: [["tld1", "tld2"], ["https://rdap.example/"]]
                if len(entry) >= 2 and entry[1]:
                    base = entry[1][0].rstrip("/")
                    for tld in entry[0]:
                        mapping[tld.lower()] = base
            _bootstrap_cache = mapping
            _bootstrap_fetched_at = now

    tld = domain.rsplit(".", 1)[-1].lower()
    return _bootstrap_cache.get(tld)


def _extract_registrar(body: dict[str, Any]) -> str:
    for entity in body.get("entities", []) or []:
        roles = entity.get("roles") or []
        if "registrar" not in roles:
            continue
        # RDAP entities encode vcards as ["vcard", [[...]]] — find fn.
        v = entity.get("vcardArray")
        if isinstance(v, list) and len(v) >= 2 and isinstance(v[1], list):
            for field in v[1]:
                # field shape: ["fn", {}, "text", "Registrar Name"]
                if (
                    isinstance(field, list)
                    and len(field) >= 4
                    and field[0] == "fn"
                ):
                    return str(field[3]).strip()
        if entity.get("handle"):
            return str(entity["handle"]).strip()
    return ""


def _extract_expires_on(body: dict[str, Any]) -> date | None:
    for event in body.get("events", []) or []:
        if event.get("eventAction") != "expiration":
            continue
        raw = event.get("eventDate")
        if not raw:
            continue
        # RDAP eventDate is RFC3339 — strip the time/tz to a date.
        for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d"):
            try:
                return datetime.strptime(raw[:19], fmt[:19]).date()
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
        except ValueError:
            return None
    return None


async def check(domain: str, client: httpx.AsyncClient | None = None) -> ProviderResult:
    """One RDAP check. Caller may pass a shared httpx.AsyncClient for
    connection pooling across a batch."""
    started = time.monotonic()
    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=10.0)

    try:
        server = await _get_rdap_server(domain, client)
        if not server:
            # Early short-circuit: no RDAP server in the IANA bootstrap
            # for this TLD ⇒ don't waste a request. Cascade continues to
            # the next provider. Message changed from "no RDAP server
            # registered" to "not supported by RDAP" (2026-05-17) — the
            # latter matches the user-facing label and reads as a clear
            # status, not a transient error.
            tld = domain.rsplit(".", 1)[-1]
            return ProviderResult(
                provider="rdap",
                status=STATUS_UNKNOWN,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"TLD .{tld} not supported by RDAP",
                error_category=ERR_CAT_RDAP,
            )
        url = f"{server}/domain/{domain}"
        try:
            r = await client.get(url, headers={"Accept": "application/rdap+json"})
        except httpx.TimeoutException as e:
            return ProviderResult(
                provider="rdap",
                status=STATUS_ERROR,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"RDAP timeout: {e}",
                error_category=ERR_CAT_NETWORK,
            )
        except httpx.HTTPError as e:
            return ProviderResult(
                provider="rdap",
                status=STATUS_ERROR,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"RDAP transport error: {e}",
                error_category=ERR_CAT_NETWORK,
            )

        latency = int((time.monotonic() - started) * 1000)
        if r.status_code == 404:
            return ProviderResult(
                provider="rdap",
                status=STATUS_AVAILABLE,
                latency_ms=latency,
            )
        if r.status_code == 429:
            return ProviderResult(
                provider="rdap",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message="RDAP rate-limited (429)",
                error_category=ERR_CAT_QUOTA,
            )
        if r.status_code >= 500:
            return ProviderResult(
                provider="rdap",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"RDAP server error {r.status_code}",
                error_category=ERR_CAT_RDAP,
            )
        if r.status_code != 200:
            return ProviderResult(
                provider="rdap",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"RDAP HTTP {r.status_code}",
                error_category=ERR_CAT_RDAP,
            )
        try:
            body = r.json()
        except (json.JSONDecodeError, ValueError) as e:
            return ProviderResult(
                provider="rdap",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"RDAP parse error: {e}",
                error_category=ERR_CAT_PARSE,
            )
        return ProviderResult(
            provider="rdap",
            status=STATUS_REGISTERED,
            latency_ms=latency,
            registrar=_extract_registrar(body),
            expires_on=_extract_expires_on(body),
            raw_response=json.dumps(body)[:8000],
        )
    finally:
        if own_client:
            await client.aclose()
