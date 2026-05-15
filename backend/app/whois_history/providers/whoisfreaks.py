"""WhoisFreaks Historical WHOIS API.

Endpoint shape (verified against live responses 2026-05-15):

    GET https://api.whoisfreaks.com/v1.0/whois
        ?apiKey={KEY}
        &whois=historical
        &domainName={DOMAIN}

Response (HTTP 200):
    {
      "status": true,
      "whois": "historical",
      "total_records": "15",                  # string, not int
      "whois_domains_historical": [ ...record... ]
    }

A "record" (.kz / ccTLD shape — gTLDs add `create_date`, `update_date`,
`expiry_date`, `domain_registrar`):
    {
      "num": 1,
      "status": true,
      "domain_name": "...",
      "query_time": "2020-04-03 15:08:18",
      "registrant_contact": {
        "name": "...", "company": "...", "city": "...",
        "country_name": "Kazakhstan",
        "country_code": "KZ"
      },
      "administrative_contact": {
        "name": "...", "email_address": "...", "phone": "...", ...
      },
      "name_servers": ["ns1.ps.kz", "ns.ps.kz"],
      "domain_status": ["clienttransferprohibited-"]
    }

The parser is intentionally TOLERANT of multiple schema variants:
  • top-level array: `whois_domains_historical` (current) OR
    `whois_records` (older / undocumented variant)
  • country field on contacts: `country_name` (current) OR `country`
  • registrar: flat `registrar_name` / `domain_registrar.registrar_name`
  • dates: `create_date`/`update_date`/`expiry_date` OR
    `created_date`/`updated_date`/`expires_date`

Belt-and-braces parsing because WhoisFreaks's documentation lags
their live shape; we'd rather quietly accept either than break on a
silent schema flip.

Errors come back two ways:
  • HTTP 200 + `{"status": false, "error": ...}` (their legacy convention)
  • HTTP 429 / 401 / 403 + a JSON envelope with `error` + `message`
    (newer error shape — observed during free-tier rate-limit testing)
Both surface as WhoisProviderError with the message text.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime
from typing import Any

import httpx

from ...limits import limit
from ..base import WhoisProvider, WhoisProviderError, WhoisRecord

log = logging.getLogger(__name__)

# WhoisFreaks's documented endpoint. Versioned so a future v2.0 rollout
# is a single-line change.
_API_BASE = "https://api.whoisfreaks.com/v1.0/whois"

# Per-call timeout. Their API is usually < 2s but historical lookups on
# long-lived domains can hit 5-10s.
_TIMEOUT_SECONDS = 30.0

# Retry policy. WhoisFreaks occasionally 5xxs under load; one retry
# with backoff is usually enough.
_MAX_RETRIES = 2


def _parse_date(s: Any) -> date | None:
    """WhoisFreaks emits dates as `YYYY-MM-DD` strings. They sometimes
    pad with time-of-day; tolerate both. Returns None for empty / bad
    input so the diff computer's None-aware logic kicks in."""
    if not s or not isinstance(s, str):
        return None
    s = s.strip()
    if not s:
        return None
    # Fast path — the documented shape.
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        pass
    # Datetime fallback (some endpoints/versions include time).
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _norm_nameservers(ns: Any) -> list[str]:
    """Lowercase + dedupe + sort. Done at parse time so equality
    comparisons in the diff computer don't trip on case or order
    variation that's semantically identical."""
    if not isinstance(ns, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for n in ns:
        if not isinstance(n, str):
            continue
        v = n.strip().lower()
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(v)
    out.sort()
    return out


def _norm_status(codes: Any) -> list[str]:
    """EPP status codes — normalize spacing + case-insensitive dedupe,
    but PRESERVE the camelCase convention because most documentation
    refers to them that way (`clientTransferProhibited` not the all-
    lowercase form). We lowercase only the dedup key, not the output.
    """
    if not isinstance(codes, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for c in codes:
        if not isinstance(c, str):
            continue
        v = c.strip()
        if not v:
            continue
        key = v.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(v)
    return out


def _map_contact(contact: Any) -> dict[str, str]:
    """Pull a name/company/email/country/state/city set out of a
    WhoisFreaks contact block. Empty string for anything missing — the
    diff computer's "no signal" branch handles those uniformly.

    Schema tolerance: live responses use `country_name` (preferred);
    older / undocumented variants used the bare `country`. Try the
    preferred field first, fall back to the legacy spelling.
    """
    if not isinstance(contact, dict):
        return {}
    country = (
        contact.get("country_name")
        or contact.get("country")
        or ""
    ).strip()
    return {
        "name": (contact.get("name") or "").strip(),
        "company": (contact.get("company") or "").strip(),
        "country": country,
        "state": (contact.get("state") or "").strip(),
        "city": (contact.get("city") or "").strip(),
        "email": (contact.get("email_address") or "").strip(),
    }


def _first_present(raw: dict[str, Any], *keys: str) -> Any:
    """First non-empty value from `raw[k]` over the listed keys.
    Used to absorb the multi-variant date field naming WhoisFreaks
    uses across endpoint versions (`create_date` vs `created_date`,
    `expiry_date` vs `expires_date`, etc.)."""
    for k in keys:
        v = raw.get(k)
        if v not in (None, ""):
            return v
    return None


def _record_from_json(raw: dict[str, Any]) -> WhoisRecord | None:
    """Map ONE WhoisFreaks record dict into a canonical WhoisRecord.
    Returns None if the record is unusable (no query_time AND no
    creation_date — we can't place it on the timeline).
    """
    # Date fields — WhoisFreaks uses two naming conventions across
    # endpoint versions; accept either spelling for each.
    query_raw = _first_present(raw, "query_time", "queried_at")
    create_raw = _first_present(raw, "create_date", "created_date", "creation_date")
    update_raw = _first_present(raw, "update_date", "updated_date", "last_updated")
    expiry_raw = _first_present(
        raw, "expiry_date", "expires_date", "expiration_date",
    )

    query_time = _parse_date(query_raw)
    # Some older records lack query_time but have update_date — use
    # that as a poor-man's "as of" so we can still order them.
    if query_time is None:
        query_time = _parse_date(update_raw)
    if query_time is None:
        # Final fallback: creation_date. Snapshots with no time signal
        # at all are skipped (they'd pollute coverage-gap detection).
        query_time = _parse_date(create_raw)
    if query_time is None:
        return None

    # Registrar can appear two ways:
    #  • nested under `domain_registrar` (gTLD shape)
    #  • flat `registrar_name` / `registrar` at the top level (some
    #    ccTLD endpoints; observed on .kz which omits the nested block
    #    entirely).
    registrar_block = raw.get("domain_registrar") or {}
    flat_registrar = (
        raw.get("registrar_name")
        or raw.get("registrar")
        or ""
    )
    registrant = _map_contact(raw.get("registrant_contact"))
    admin = _map_contact(raw.get("administrative_contact"))
    tech = _map_contact(raw.get("technical_contact"))

    # DNSSEC field shape varies — WhoisFreaks sometimes uses
    # `dnssec` (string "signedDelegation" / "unsigned"), sometimes a
    # boolean. Coerce to bool|None.
    dnssec_raw = raw.get("dnssec")
    if isinstance(dnssec_raw, bool):
        dnssec_enabled: bool | None = dnssec_raw
    elif isinstance(dnssec_raw, str):
        v = dnssec_raw.strip().lower()
        if v in ("signed", "signeddelegation", "yes", "true", "enabled"):
            dnssec_enabled = True
        elif v in ("unsigned", "no", "false", "disabled", ""):
            dnssec_enabled = False
        else:
            dnssec_enabled = None
    else:
        dnssec_enabled = None

    # Stash everything we DIDN'T map into extras so the AI prompt's
    # raw-records section still sees provider-specific fields (raw text,
    # billing contacts, etc.) without us having to enumerate every
    # column WhoisFreaks might add later. Includes both date-name
    # variants so a future schema flip doesn't double-emit.
    consumed_keys = {
        "query_time", "queried_at",
        "create_date", "created_date", "creation_date",
        "update_date", "updated_date", "last_updated",
        "expiry_date", "expires_date", "expiration_date",
        "domain_registrar", "registrar_name", "registrar",
        "registrant_contact",
        "administrative_contact", "technical_contact",
        "name_servers", "domain_status", "dnssec",
        # `num` and per-record `status` are WhoisFreaks bookkeeping —
        # not signal. Drop them from extras too.
        "num", "status",
    }
    extras = {k: v for k, v in raw.items() if k not in consumed_keys}

    return WhoisRecord(
        query_time=query_time,
        creation_date=_parse_date(create_raw),
        update_date=_parse_date(update_raw),
        expiry_date=_parse_date(expiry_raw),
        registrar_name=(
            (registrar_block.get("registrar_name") or "").strip()
            or str(flat_registrar).strip()
        ),
        registrar_iana_id=str(registrar_block.get("iana_id") or "").strip(),
        whois_server=(registrar_block.get("whois_server") or "").strip(),
        registrant_name=registrant.get("name", ""),
        registrant_org=registrant.get("company", ""),
        registrant_country=registrant.get("country", ""),
        registrant_state=registrant.get("state", ""),
        registrant_city=registrant.get("city", ""),
        registrant_email=registrant.get("email", ""),
        admin_email=admin.get("email", ""),
        tech_email=tech.get("email", ""),
        name_servers=_norm_nameservers(raw.get("name_servers")),
        domain_status=_norm_status(raw.get("domain_status")),
        dnssec_enabled=dnssec_enabled,
        extras=extras,
    )


def parse_response(body: dict[str, Any]) -> list[WhoisRecord]:
    """Public for tests + the fetcher's cache path. Maps a full
    WhoisFreaks response into the chronologically-sorted record list.

    Tolerates both array-key naming conventions:
      • `whois_domains_historical` (live + documented)
      • `whois_records` (older / undocumented variant kept as fallback)

    Error envelopes are handled with the same tolerance — both legacy
    (HTTP 200 + `status: false`) and modern (HTTP 4xx + `error` +
    `message`) shapes raise WhoisProviderError with the human-readable
    message text.
    """
    if not isinstance(body, dict):
        raise WhoisProviderError("WhoisFreaks response is not a JSON object")
    # Status flag — accept the modern "true"/"false" boolean AND the
    # newer numeric envelope where `status` is an HTTP code (429 etc).
    status_val = body.get("status")
    if status_val is False or (
        isinstance(status_val, int) and status_val >= 400
    ):
        err = (
            body.get("message")
            or body.get("error")
            or "unknown error"
        )
        if isinstance(err, dict):
            err = err.get("message") or str(err)
        raise WhoisProviderError(f"WhoisFreaks error: {err}")
    records_raw = (
        body.get("whois_domains_historical")
        or body.get("whois_records")
        or []
    )
    if not isinstance(records_raw, list):
        # No history available is a valid response — return empty.
        return []
    records: list[WhoisRecord] = []
    for raw in records_raw:
        if not isinstance(raw, dict):
            continue
        rec = _record_from_json(raw)
        if rec is not None:
            records.append(rec)
    # Chronological: oldest first. Stable sort so equal query_times
    # preserve their incoming order (the provider's tie-break).
    records.sort(key=lambda r: r.query_time)
    return records


class WhoisFreaksProvider(WhoisProvider):
    """Concrete WhoisProvider for WhoisFreaks Historical WHOIS API.

    Constructor takes the API key explicitly (rather than reading
    app_settings) so tests can instantiate without DB access and so
    fetcher.py owns the "where credentials come from" policy."""

    name = "whoisfreaks"

    def __init__(
        self,
        api_key: str,
        *,
        timeout_seconds: float = _TIMEOUT_SECONDS,
        max_retries: int = _MAX_RETRIES,
    ):
        if not api_key:
            raise WhoisProviderError(
                "WhoisFreaks API key is empty — set it in "
                "Settings → Whois History"
            )
        self._api_key = api_key
        self._timeout = timeout_seconds
        self._max_retries = max_retries

    async def fetch_history(
        self,
        domain: str,
        *,
        max_records: int | None = None,
    ) -> list[WhoisRecord]:
        params = {
            "apiKey": self._api_key,
            "whois": "historical",
            "domainName": domain,
        }
        last_err: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                # Gate every HTTP request through the per-provider
                # rate limiter (token bucket + concurrency semaphore).
                # User-configurable in Settings → Whois History → Rate
                # limits — see `_RATE_LIMIT_DEFAULTS["whoisfreaks"]`
                # for the defaults. Wrapping the request (not the
                # whole retry loop) ensures retries also pay the rate
                # cost, preventing a retry burst from re-triggering
                # the 429 we just bounced off of.
                async with limit("whoisfreaks"):
                    async with httpx.AsyncClient(timeout=self._timeout) as client:
                        resp = await client.get(_API_BASE, params=params)
                # WhoisFreaks puts auth errors in HTTP 200 + status:false
                # AND uses 401/403 for the same thing depending on
                # endpoint version. Map both to WhoisProviderError.
                if resp.status_code in (401, 403):
                    raise WhoisProviderError(
                        f"WhoisFreaks auth failed (HTTP {resp.status_code}) "
                        f"— check the API key in Settings → Whois History"
                    )
                if resp.status_code in (429,):
                    raise WhoisProviderError(
                        "WhoisFreaks rate-limited (HTTP 429) — slow the "
                        "request rate or upgrade the plan"
                    )
                if resp.status_code >= 500:
                    # Retryable
                    raise httpx.HTTPStatusError(
                        f"server error {resp.status_code}",
                        request=resp.request,
                        response=resp,
                    )
                if resp.status_code != 200:
                    raise WhoisProviderError(
                        f"WhoisFreaks HTTP {resp.status_code}: "
                        f"{resp.text[:200]}"
                    )
                body = resp.json()
                records = parse_response(body)
                if max_records and len(records) > max_records:
                    # Keep the NEWEST `max_records` since most-recent
                    # snapshots have the strongest drop signals (recent
                    # creation_date change, recent pendingDelete status).
                    records = records[-max_records:]
                return records
            except WhoisProviderError:
                # Non-retryable provider errors propagate immediately.
                raise
            except (httpx.HTTPError, ValueError) as e:
                last_err = e
                if attempt < self._max_retries:
                    # Exponential backoff capped at 5s.
                    await asyncio.sleep(min(0.5 * (2 ** attempt), 5.0))
                    continue
                break
        raise WhoisProviderError(
            f"WhoisFreaks fetch failed after {self._max_retries + 1} attempts: "
            f"{last_err}"
        )
