"""Shared types for the availability cascade providers.

A `ProviderResult` is what every provider returns. Translated into
AvailabilityCheck DB rows by the cascade orchestrator.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


# Status taxonomy — kept in sync with AvailabilityCheck.status column.
STATUS_AVAILABLE = "available"
STATUS_REGISTERED = "registered"
STATUS_UNKNOWN = "unknown"
STATUS_ERROR = "error"

# Error categories — drive the Errors-page category filter (DNS / RDAP
# / WHOIS / etc).
ERR_CAT_DNS = "dns"
ERR_CAT_RDAP = "rdap"
ERR_CAT_DOMAINR = "domainr"
ERR_CAT_WHOIS = "whois"
ERR_CAT_NETWORK = "network"
ERR_CAT_QUOTA = "quota"
ERR_CAT_PARSE = "parse"


@dataclass
class ProviderResult:
    """One provider's verdict on one domain check."""
    provider: str  # 'dns' | 'rdap' | 'domainr' | 'whois'
    status: str  # one of STATUS_*
    latency_ms: int = 0
    registrar: str = ""
    expires_on: date | None = None
    error_message: str = ""
    error_category: str = ""
    raw_response: str = ""

    @property
    def is_terminal(self) -> bool:
        """A 'terminal' result is one the cascade can stop on. Available
        and registered are terminal — we have an authoritative answer.
        Unknown and error fall through to the next provider."""
        return self.status in (STATUS_AVAILABLE, STATUS_REGISTERED)


def normalize_domain(raw: str) -> str:
    """Lowercase + strip scheme/path. Matches the rest of Drop
    Sherlock's domain canonicalization (see backlog import path)."""
    s = (raw or "").strip().lower()
    for prefix in ("https://", "http://"):
        if s.startswith(prefix):
            s = s[len(prefix):]
    s = s.split("/", 1)[0]
    # Strip trailing dots (FQDN form) so 'example.com.' and 'example.com'
    # share the same cache row.
    return s.rstrip(".")
