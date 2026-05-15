"""Provider abstraction + canonical record shape for the WHOIS history
pillar (Wave 2, 2026-05-15).

`WhoisProvider` is an abstract protocol. Concrete impls (today only
`WhoisFreaksProvider`) live in providers/. The fetcher dispatches by
provider name from app_settings; the contract is uniform so adding a
second provider later (WhoisXMLAPI / DomainTools / SecurityTrails) is
a single new file, no diff to the consumer side.

`WhoisRecord` is the canonical row shape we store + show to the AI
judge. Every provider's API response is mapped INTO this shape during
fetch, so the AI never sees vendor-specific field names. Fields with
no obvious mapping land in `extras` as a free-form dict for prompts
that want to display them; the schema fields are the ones the diff
computer reads.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


@dataclass
class WhoisRecord:
    """One historical WHOIS snapshot, vendor-neutral.

    `query_time` is when the PROVIDER polled the registry to capture
    this snapshot — distinct from `update_date` which is what the
    registry's own record said about itself at that moment. We treat
    `query_time` as the snapshot's "as-of" timestamp for ordering /
    coverage-gap detection; `update_date` is content metadata.

    Optional fields are None when the provider didn't return them
    (common post-GDPR for registrant fields). The diff computer treats
    None as "no signal", not as "this changed to nothing" — change
    detection requires non-None values on both sides of a comparison.
    """

    # Required — every record we accept must have at least a poll time.
    query_time: date

    # Registry-side dates from the snapshot itself.
    creation_date: date | None = None
    update_date: date | None = None
    expiry_date: date | None = None

    # Registrar metadata.
    registrar_name: str = ""
    registrar_iana_id: str = ""
    whois_server: str = ""

    # Registrant contact — almost entirely redacted post-GDPR for gTLDs
    # but consistently populated for ccTLDs that haven't aligned with
    # the redaction wave (.ru, .kz, .de pre-2018 historical data, etc.).
    registrant_name: str = ""
    registrant_org: str = ""
    registrant_country: str = ""
    registrant_state: str = ""
    registrant_city: str = ""
    registrant_email: str = ""

    # Admin / tech contacts — usually mirror registrant or are redacted.
    # Stored separately so the diff computer can detect divergence
    # (admin staying constant while registrant flips suggests the same
    # owner moving registrars).
    admin_email: str = ""
    tech_email: str = ""

    # Nameservers — lowercased + sorted by the provider mapper so equality
    # comparisons across snapshots don't trip on case / order changes
    # within the same NS set.
    name_servers: list[str] = field(default_factory=list)

    # EPP status codes (`clientTransferProhibited`, `redemptionPeriod`,
    # `pendingDelete`, etc.). The strongest drop-detection signal — see
    # diff.py for the explicit list of "in the drop pipeline" codes.
    domain_status: list[str] = field(default_factory=list)

    # DNSSEC delegation. None when the provider didn't tell us; True/False
    # when they did. NOT a strong drop signal on its own — owners toggle
    # DNSSEC when adding/removing CDNs — but a paired toggle alongside
    # other changes is suggestive.
    dnssec_enabled: bool | None = None

    # Provider-specific extras that don't fit the schema. Surfaced in
    # the AI prompt's raw records section so the judge can read them,
    # but never consumed by the diff computer (kept free-form on purpose).
    extras: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """JSON-serializable representation. Used by the storage layer
        (CriterionResult.data_json) and by tests.

        Dates are emitted as ISO strings so the resulting blob survives
        a JSON round-trip cleanly."""

        def _iso(d: date | None) -> str | None:
            return d.isoformat() if d else None

        return {
            "query_time": _iso(self.query_time),
            "creation_date": _iso(self.creation_date),
            "update_date": _iso(self.update_date),
            "expiry_date": _iso(self.expiry_date),
            "registrar_name": self.registrar_name,
            "registrar_iana_id": self.registrar_iana_id,
            "whois_server": self.whois_server,
            "registrant_name": self.registrant_name,
            "registrant_org": self.registrant_org,
            "registrant_country": self.registrant_country,
            "registrant_state": self.registrant_state,
            "registrant_city": self.registrant_city,
            "registrant_email": self.registrant_email,
            "admin_email": self.admin_email,
            "tech_email": self.tech_email,
            "name_servers": list(self.name_servers),
            "domain_status": list(self.domain_status),
            "dnssec_enabled": self.dnssec_enabled,
            "extras": dict(self.extras),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "WhoisRecord":
        """Inverse of `to_dict`. Used by tests + by the recompute path
        when the runner reads a cached CR row back from the DB."""

        def _parse(s: str | None) -> date | None:
            if not s:
                return None
            try:
                return date.fromisoformat(s)
            except (TypeError, ValueError):
                try:
                    return datetime.fromisoformat(s).date()
                except (TypeError, ValueError):
                    return None

        return cls(
            query_time=_parse(d.get("query_time"))
            or date.fromtimestamp(0),  # final fallback: epoch
            creation_date=_parse(d.get("creation_date")),
            update_date=_parse(d.get("update_date")),
            expiry_date=_parse(d.get("expiry_date")),
            registrar_name=d.get("registrar_name") or "",
            registrar_iana_id=d.get("registrar_iana_id") or "",
            whois_server=d.get("whois_server") or "",
            registrant_name=d.get("registrant_name") or "",
            registrant_org=d.get("registrant_org") or "",
            registrant_country=d.get("registrant_country") or "",
            registrant_state=d.get("registrant_state") or "",
            registrant_city=d.get("registrant_city") or "",
            registrant_email=d.get("registrant_email") or "",
            admin_email=d.get("admin_email") or "",
            tech_email=d.get("tech_email") or "",
            name_servers=list(d.get("name_servers") or []),
            domain_status=list(d.get("domain_status") or []),
            dnssec_enabled=d.get("dnssec_enabled"),
            extras=dict(d.get("extras") or {}),
        )


class WhoisProviderError(Exception):
    """Raised by providers for any non-recoverable failure (auth, quota,
    network). The fetcher catches and stashes the message in the
    CriterionResult.error field so the operator sees what broke."""


class WhoisProvider(ABC):
    """Provider contract — vendor-neutral. Implementations live in
    providers/ and are instantiated by the fetcher based on
    app_settings.

    The contract is intentionally minimal: take a domain, return a list
    of WhoisRecord. All quota / rate-limit concerns are the
    implementation's responsibility. The fetcher catches
    WhoisProviderError and reports through the existing CR.error path.
    """

    # Short identifier used in app_settings keys (whoisfreaks__api_key
    # etc.) and in logs. Must be unique across providers.
    name: str

    @abstractmethod
    async def fetch_history(
        self,
        domain: str,
        *,
        max_records: int | None = None,
    ) -> list[WhoisRecord]:
        """Pull every historical WHOIS snapshot the provider has for
        `domain`, mapped into the canonical WhoisRecord shape.

        `max_records` is a soft cap from app_settings — providers may
        return fewer (no records available) but must not return more.
        Records are sorted chronologically (oldest → newest) on return
        so the diff computer + prompt builder can iterate predictably.

        Raises WhoisProviderError on auth/quota/network failures.
        Empty list is a valid return (domain has no recorded history).
        """
        raise NotImplementedError
