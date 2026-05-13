"""Port-43 WHOIS — final fallback for TLDs without RDAP or when other
providers fail.

WHOIS responses are plain-text and not standardized — each registry has
its own format. We do a best-effort parse for two anchors:
  - "no match" / "not found" / "no data found" / "domain not found" →
    STATUS_AVAILABLE.
  - "registrar:" + "registry expiry date:" / "expiration date:" /
    "expires:" → STATUS_REGISTERED with extracted values.

Server discovery: hardcoded gTLD → whois server map (the same set IANA
publishes). For uncovered TLDs we ask whois.iana.org which always
answers with the authoritative WHOIS server for any TLD.
"""
from __future__ import annotations

import asyncio
import re
import time
from datetime import date, datetime

from .common import (
    ERR_CAT_NETWORK,
    ERR_CAT_PARSE,
    ERR_CAT_WHOIS,
    ProviderResult,
    STATUS_AVAILABLE,
    STATUS_ERROR,
    STATUS_REGISTERED,
    STATUS_UNKNOWN,
)


# Hardcoded TLD → WHOIS server for the gTLDs the user said they target.
# Covers ~99% of drop-hunter traffic without making a discovery RTT
# to whois.iana.org for every check.
_TLD_WHOIS: dict[str, str] = {
    "com": "whois.verisign-grs.com",
    "net": "whois.verisign-grs.com",
    "org": "whois.publicinterestregistry.org",
    "io": "whois.nic.io",
    "co": "whois.nic.co",
    "ai": "whois.nic.ai",
    "dev": "whois.nic.google",
    "app": "whois.nic.google",
}
_IANA_WHOIS = "whois.iana.org"
_PORT = 43
_TIMEOUT_SEC = 5.0

_AVAILABLE_PATTERNS = [
    re.compile(r"^\s*no\s+match", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*not\s+found", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*no\s+data\s+found", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^\s*domain\s+not\s+found", re.IGNORECASE | re.MULTILINE),
    re.compile(r"available\s+for\s+(registration|purchase)", re.IGNORECASE),
]
_REGISTRAR_PATTERN = re.compile(r"^\s*Registrar:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_EXPIRY_PATTERN = re.compile(
    r"^\s*(?:Registry\s+Expiry\s+Date|Registrar\s+Registration\s+Expiration\s+Date|Expiration\s+Date|Expires\s+On|Expiry\s+date|paid-till):\s*(\S+)",
    re.IGNORECASE | re.MULTILINE,
)


async def _query(server: str, query: str) -> str:
    """Open TCP, send query + CRLF, read until EOF, return decoded body."""
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(server, _PORT), timeout=_TIMEOUT_SEC,
    )
    try:
        writer.write((query + "\r\n").encode("utf-8"))
        await writer.drain()
        chunks: list[bytes] = []
        while True:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=_TIMEOUT_SEC)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8", errors="replace")
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


def _parse_expires(raw: str) -> date | None:
    if not raw:
        return None
    raw = raw.strip().rstrip(".")
    for fmt in (
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
        "%d-%b-%Y",
        "%d.%m.%Y",
    ):
        try:
            return datetime.strptime(raw[:max(len(fmt), 10)], fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        return None


async def check(domain: str) -> ProviderResult:
    started = time.monotonic()
    tld = domain.rsplit(".", 1)[-1].lower()
    server = _TLD_WHOIS.get(tld)
    try:
        if server is None:
            # Ask IANA which WHOIS server to talk to for this TLD.
            iana_body = await _query(_IANA_WHOIS, tld)
            m = re.search(
                r"^\s*refer:\s*(\S+)\s*$", iana_body, re.IGNORECASE | re.MULTILINE,
            )
            if not m:
                return ProviderResult(
                    provider="whois",
                    status=STATUS_UNKNOWN,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    error_message=f"WHOIS: IANA didn't refer a server for .{tld}",
                    error_category=ERR_CAT_WHOIS,
                )
            server = m.group(1).strip()

        body = await _query(server, domain)
    except asyncio.TimeoutError as e:
        return ProviderResult(
            provider="whois",
            status=STATUS_ERROR,
            latency_ms=int((time.monotonic() - started) * 1000),
            error_message=f"WHOIS timeout: {e}",
            error_category=ERR_CAT_NETWORK,
        )
    except OSError as e:
        return ProviderResult(
            provider="whois",
            status=STATUS_ERROR,
            latency_ms=int((time.monotonic() - started) * 1000),
            error_message=f"WHOIS network: {e}",
            error_category=ERR_CAT_NETWORK,
        )
    except Exception as e:  # noqa: BLE001
        return ProviderResult(
            provider="whois",
            status=STATUS_ERROR,
            latency_ms=int((time.monotonic() - started) * 1000),
            error_message=f"WHOIS error: {e}",
            error_category=ERR_CAT_WHOIS,
        )

    latency = int((time.monotonic() - started) * 1000)
    # Available? Match before parsing registrar (some registries return
    # both "no match" and a generic registrar template).
    for pat in _AVAILABLE_PATTERNS:
        if pat.search(body):
            return ProviderResult(
                provider="whois",
                status=STATUS_AVAILABLE,
                latency_ms=latency,
                raw_response=body[:4000],
            )
    registrar_m = _REGISTRAR_PATTERN.search(body)
    expiry_m = _EXPIRY_PATTERN.search(body)
    if registrar_m or expiry_m:
        return ProviderResult(
            provider="whois",
            status=STATUS_REGISTERED,
            latency_ms=latency,
            registrar=(registrar_m.group(1).strip() if registrar_m else ""),
            expires_on=_parse_expires(expiry_m.group(1) if expiry_m else ""),
            raw_response=body[:4000],
        )
    # Plain-text WHOIS that doesn't match any of our patterns. Treat as
    # unknown — caller's cascade has nothing else left, but we don't
    # want to claim a status we couldn't verify.
    return ProviderResult(
        provider="whois",
        status=STATUS_UNKNOWN,
        latency_ms=latency,
        error_message="WHOIS response did not match known patterns",
        error_category=ERR_CAT_PARSE,
        raw_response=body[:4000],
    )
