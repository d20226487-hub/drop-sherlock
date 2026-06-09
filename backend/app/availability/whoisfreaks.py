"""WhoisFreaks live WHOIS — availability cascade provider (added 2026-06-08).

A 5th availability provider, distinct from the existing port-43 `whois`
provider AND from the Whois History pillar. The Whois History pillar uses
WhoisFreaks' *historical* endpoint for drop detection; THIS provider uses
the *live* endpoint purely to answer "registered vs available" — handy for
ccTLDs that RDAP/Domainr don't cover well (e.g. .kz).

Reuses the SAME WhoisFreaks API key configured under Settings → Whois
History (`get_whois_history_api_key`) — there is no separate credential.

Endpoint: GET https://api.whoisfreaks.com/v1.0/whois
            ?apiKey={KEY}&whois=live&domainName={DOMAIN}
Cost: 1 WhoisFreaks credit per lookup (paid / metered) — keep this provider
DISABLED unless you specifically need it for a TLD the free/cheaper
providers miss. It is off by default and never in the default cascade
position before the cheaper providers.

Mapping (verified against live responses 2026-06-08):
  domain_registered == "yes" / true  → registered (registrar + expiry
                                        extracted when present)
  domain_registered == "no"  / false → available
  HTTP 200 + status:false / status>=400 (legacy error envelope) → error
  missing / other domain_registered   → unknown (cascade continues)
"""
from __future__ import annotations

import json
import time
from datetime import date, datetime
from typing import Any

import httpx

from ..app_settings import get_whois_history_api_key
from .common import (
    ERR_CAT_NETWORK,
    ERR_CAT_PARSE,
    ERR_CAT_QUOTA,
    ERR_CAT_WHOISFREAKS,
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    STATUS_UNKNOWN,
)


_API_BASE = "https://api.whoisfreaks.com/v1.0/whois"


def _parse_date(s: Any) -> date | None:
    """WhoisFreaks emits dates as YYYY-MM-DD (sometimes with a time
    suffix). Tolerate both; None on anything unparseable."""
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _extract_registrar(body: dict[str, Any]) -> str:
    """Registrar appears nested (gTLD shape: domain_registrar.registrar_name)
    or flat (some ccTLD endpoints). Try both."""
    nested = body.get("domain_registrar")
    if isinstance(nested, dict):
        name = (nested.get("registrar_name") or "").strip()
        if name:
            return name
    flat = body.get("registrar_name") or body.get("registrar") or ""
    return str(flat).strip()


def _extract_expiry(body: dict[str, Any]) -> date | None:
    for k in ("expiry_date", "expires_date", "expiration_date"):
        d = _parse_date(body.get(k))
        if d is not None:
            return d
    return None


async def check(domain: str, client: httpx.AsyncClient | None = None) -> ProviderResult:
    started = time.monotonic()
    api_key = get_whois_history_api_key()
    if not api_key:
        return ProviderResult(
            provider="whoisfreaks",
            status=STATUS_ERROR,
            latency_ms=0,
            error_message="WhoisFreaks API key not configured (Settings → Whois History)",
            error_category=ERR_CAT_WHOISFREAKS,
        )

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=15.0)

    try:
        try:
            r = await client.get(
                _API_BASE,
                params={"apiKey": api_key, "whois": "live", "domainName": domain},
            )
        except httpx.TimeoutException as e:
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"WhoisFreaks timeout: {e}",
                error_category=ERR_CAT_NETWORK,
            )
        except httpx.HTTPError as e:
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=int((time.monotonic() - started) * 1000),
                error_message=f"WhoisFreaks transport: {e}",
                error_category=ERR_CAT_NETWORK,
            )

        latency = int((time.monotonic() - started) * 1000)
        if r.status_code == 429:
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message="WhoisFreaks rate-limited / quota exhausted",
                error_category=ERR_CAT_QUOTA,
            )
        if r.status_code in (401, 403):
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=(
                    f"WhoisFreaks auth failed ({r.status_code}) — check the API "
                    "key in Settings → Whois History"
                ),
                error_category=ERR_CAT_WHOISFREAKS,
            )
        if r.status_code >= 500:
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"WhoisFreaks server error {r.status_code}",
                error_category=ERR_CAT_WHOISFREAKS,
            )
        if r.status_code != 200:
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"WhoisFreaks HTTP {r.status_code}",
                error_category=ERR_CAT_WHOISFREAKS,
            )
        try:
            body = r.json()
        except (json.JSONDecodeError, ValueError) as e:
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"WhoisFreaks parse: {e}",
                error_category=ERR_CAT_PARSE,
            )
        if not isinstance(body, dict):
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_UNKNOWN,
                latency_ms=latency,
                error_message="WhoisFreaks response was not a JSON object",
                error_category=ERR_CAT_PARSE,
            )
        # WhoisFreaks's legacy error convention: HTTP 200 + status:false,
        # or a numeric status code in the body for newer error envelopes.
        status_val = body.get("status")
        if status_val is False or (isinstance(status_val, int) and status_val >= 400):
            err = body.get("message") or body.get("error") or "unknown error"
            if isinstance(err, dict):
                err = err.get("message") or str(err)
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_ERROR,
                latency_ms=latency,
                error_message=f"WhoisFreaks error: {err}",
                error_category=ERR_CAT_WHOISFREAKS,
            )

        reg = body.get("domain_registered")
        reg_s = str(reg).strip().lower() if reg is not None else ""
        if reg_s in ("no", "false", "0", "available"):
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_AVAILABLE,
                latency_ms=latency,
                raw_response=json.dumps(body)[:4000],
            )
        if reg_s in ("yes", "true", "1", "registered"):
            return ProviderResult(
                provider="whoisfreaks",
                status=STATUS_REGISTERED,
                latency_ms=latency,
                registrar=_extract_registrar(body),
                expires_on=_extract_expiry(body),
                raw_response=json.dumps(body)[:4000],
            )
        return ProviderResult(
            provider="whoisfreaks",
            status=STATUS_UNKNOWN,
            latency_ms=latency,
            error_message=f"WhoisFreaks domain_registered not actionable: {reg_s or '<empty>'}",
            raw_response=json.dumps(body)[:4000],
        )
    finally:
        if own_client:
            await client.aclose()
