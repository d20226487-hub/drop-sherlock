"""Coverage for the availability cascade + provider modules.

Provider modules are tested in isolation with a mocked httpx transport
(no live network). The cascade orchestrator is tested with monkey-
patched provider functions so we exercise the order/short-circuit/
persistence logic without the providers' own quirks.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from datetime import date, datetime
from typing import Callable

import httpx
import pytest


@pytest.fixture
def fresh_db(monkeypatch):
    """Fresh SQLite file + reimported app modules — same pattern as
    test_criterion_pins.py."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp.name}")
    for name in list(sys.modules):
        if name.startswith("app."):
            del sys.modules[name]
    if "app" in sys.modules:
        del sys.modules["app"]

    from app import db as db_mod
    from app import models  # noqa: F401
    from app.main import _migrate_sqlite_columns
    db_mod.Base.metadata.create_all(bind=db_mod.engine)
    _migrate_sqlite_columns()
    session = db_mod.SessionLocal()
    try:
        yield session
    finally:
        session.close()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


# --- RDAP provider tests -----------------------------------------------------

def _rdap_transport(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_rdap_returns_available_on_404(fresh_db):
    from app.availability import rdap
    from app.availability.common import STATUS_AVAILABLE

    def handler(req: httpx.Request) -> httpx.Response:
        if "data.iana.org" in req.url.host:
            return httpx.Response(200, json={"services": [
                [["com"], ["https://rdap.example.org/com"]],
            ]})
        return httpx.Response(404, json={"errorCode": 404})

    async def runner():
        async with _rdap_transport(handler) as client:
            return await rdap.check("example.com", client=client)

    r = asyncio.run(runner())
    assert r.status == STATUS_AVAILABLE
    assert r.provider == "rdap"


def test_rdap_returns_registered_with_extracts(fresh_db):
    from app.availability import rdap
    from app.availability.common import STATUS_REGISTERED

    rdap_body = {
        "objectClassName": "domain",
        "ldhName": "example.com",
        "entities": [
            {
                "roles": ["registrar"],
                "vcardArray": ["vcard", [
                    ["version", {}, "text", "4.0"],
                    ["fn", {}, "text", "Test Registrar Inc."],
                ]],
            },
        ],
        "events": [
            {"eventAction": "expiration", "eventDate": "2030-08-15T00:00:00Z"},
        ],
    }

    def handler(req: httpx.Request) -> httpx.Response:
        if "data.iana.org" in req.url.host:
            return httpx.Response(200, json={"services": [
                [["com"], ["https://rdap.example.org/com"]],
            ]})
        return httpx.Response(200, json=rdap_body)

    async def runner():
        async with _rdap_transport(handler) as client:
            return await rdap.check("example.com", client=client)

    r = asyncio.run(runner())
    assert r.status == STATUS_REGISTERED
    assert r.registrar == "Test Registrar Inc."
    assert r.expires_on == date(2030, 8, 15)


def test_rdap_handles_quota_429(fresh_db):
    from app.availability import rdap
    from app.availability.common import ERR_CAT_QUOTA, STATUS_ERROR

    def handler(req: httpx.Request) -> httpx.Response:
        if "data.iana.org" in req.url.host:
            return httpx.Response(200, json={"services": [
                [["com"], ["https://rdap.example.org/com"]],
            ]})
        return httpx.Response(429, text="rate limited")

    async def runner():
        async with _rdap_transport(handler) as client:
            return await rdap.check("example.com", client=client)

    r = asyncio.run(runner())
    assert r.status == STATUS_ERROR
    assert r.error_category == ERR_CAT_QUOTA


# --- Cascade tests -----------------------------------------------------------

def test_cascade_short_circuits_on_terminal(fresh_db, monkeypatch):
    """DNS returns available → RDAP/Domainr/WHOIS never called.
    History gets one row (the DNS one)."""
    from app.availability import cascade
    from app.availability.common import (
        ProviderResult,
        STATUS_AVAILABLE,
    )

    async def fake_dns(domain):
        return ProviderResult(provider="dns", status=STATUS_AVAILABLE)
    async def fail_other(*a, **k):
        raise AssertionError("should not be called")

    monkeypatch.setattr("app.availability.dns.check", fake_dns)
    monkeypatch.setattr("app.availability.rdap.check", fail_other)
    monkeypatch.setattr("app.availability.domainr.check", fail_other)
    monkeypatch.setattr("app.availability.whois.check", fail_other)

    result = asyncio.run(cascade.check_availability_async("a.com", use_cache=False))
    assert result.status == STATUS_AVAILABLE
    assert result.provider == "dns"

    # One row persisted.
    from app.models import AvailabilityCheck
    rows = fresh_db.query(AvailabilityCheck).all()
    assert len(rows) == 1
    assert rows[0].provider == "dns"


def test_cascade_falls_through_to_rdap(fresh_db, monkeypatch):
    """DNS unknown → RDAP returns registered. History gets two rows.
    Terminal answer reflects RDAP."""
    from app.availability import cascade
    from app.availability.common import (
        ProviderResult,
        STATUS_REGISTERED,
        STATUS_UNKNOWN,
    )

    async def dns_unknown(domain):
        return ProviderResult(provider="dns", status=STATUS_UNKNOWN)
    async def rdap_registered(domain, client=None):
        return ProviderResult(
            provider="rdap",
            status=STATUS_REGISTERED,
            registrar="Acme",
            expires_on=date(2027, 1, 1),
        )
    async def fail(*a, **k):
        raise AssertionError("should not be called")

    monkeypatch.setattr("app.availability.dns.check", dns_unknown)
    monkeypatch.setattr("app.availability.rdap.check", rdap_registered)
    monkeypatch.setattr("app.availability.domainr.check", fail)
    monkeypatch.setattr("app.availability.whois.check", fail)

    result = asyncio.run(cascade.check_availability_async("a.com", use_cache=False))
    assert result.status == STATUS_REGISTERED
    assert result.registrar == "Acme"
    assert result.expires_on == date(2027, 1, 1)
    assert result.provider == "rdap"

    from app.models import AvailabilityCheck
    rows = fresh_db.query(AvailabilityCheck).order_by(AvailabilityCheck.id).all()
    assert [r.provider for r in rows] == ["dns", "rdap"]


def test_cascade_uses_cache_within_ttl(fresh_db, monkeypatch):
    """A cached terminal row within TTL means providers don't get
    called at all on a follow-up check."""
    from app.availability import cascade
    from app.availability.common import (
        ProviderResult,
        STATUS_AVAILABLE,
    )

    call_count = {"dns": 0}

    async def dns_available(domain):
        call_count["dns"] += 1
        return ProviderResult(provider="dns", status=STATUS_AVAILABLE)
    async def fail(*a, **k):
        raise AssertionError("should not be called")

    monkeypatch.setattr("app.availability.dns.check", dns_available)
    monkeypatch.setattr("app.availability.rdap.check", fail)
    monkeypatch.setattr("app.availability.domainr.check", fail)
    monkeypatch.setattr("app.availability.whois.check", fail)

    # First call hits the cascade.
    asyncio.run(cascade.check_availability_async("a.com", use_cache=False))
    assert call_count["dns"] == 1

    # Second call within TTL: cache hit, no provider call.
    r2 = asyncio.run(cascade.check_availability_async("a.com", use_cache=True))
    assert call_count["dns"] == 1
    assert r2.from_cache is True


def test_cascade_skips_disabled_providers(fresh_db, monkeypatch):
    """Domainr disabled in default settings → cascade skips it even
    when RDAP returned unknown. Falls through to WHOIS (enabled at
    runtime in this test)."""
    from app.availability import cascade
    from app.availability.common import (
        ProviderResult,
        STATUS_REGISTERED,
        STATUS_UNKNOWN,
    )
    from app.app_settings import set_availability_setting

    set_availability_setting("availability__dns__enabled", "false")
    set_availability_setting("availability__rdap__enabled", "true")
    set_availability_setting("availability__domainr__enabled", "false")
    set_availability_setting("availability__whois__enabled", "true")

    async def rdap_unknown(domain, client=None):
        return ProviderResult(provider="rdap", status=STATUS_UNKNOWN)
    async def whois_registered(domain):
        return ProviderResult(
            provider="whois", status=STATUS_REGISTERED, registrar="W",
        )
    async def fail(*a, **k):
        raise AssertionError("should not be called")

    monkeypatch.setattr("app.availability.dns.check", fail)
    monkeypatch.setattr("app.availability.rdap.check", rdap_unknown)
    monkeypatch.setattr("app.availability.domainr.check", fail)
    monkeypatch.setattr("app.availability.whois.check", whois_registered)

    r = asyncio.run(cascade.check_availability_async("a.com", use_cache=False))
    assert r.status == STATUS_REGISTERED
    assert r.provider == "whois"
