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


def test_runner_preserves_terminal_verdict_across_cascade_retries(
    fresh_db, monkeypatch,
):
    """Regression for B9 (2026-05-17). When a cascade retry returns an
    error (e.g. RDAP 429) but the same run previously got a terminal
    answer for the same domain, the runner must use the prior terminal
    answer for the persisted verdict. Without this, intermittent
    rate-limits silently downgrade confirmed 'available' rows to 'error'
    and the operator sees them as failed forever."""
    from app.availability.common import STATUS_AVAILABLE, STATUS_ERROR
    from app.availability_runner import _process_availability_domain
    from app.models import AvailabilityCheck, CriterionResult, Run, RunDomain

    session = fresh_db
    run = Run(job_id=0, status="running", spec_json="{}")
    session.add(run)
    session.flush()
    rd = RunDomain(run_id=run.id, domain="b9.example", status="pending")
    session.add(rd)
    session.flush()

    # Stage the "earlier successful" attempt in this run's history: the
    # cascade already wrote one AvailabilityCheck row saying 'available'.
    earlier = datetime(2026, 5, 17, 12, 0, 0)
    session.add(AvailabilityCheck(
        domain="b9.example", run_id=run.id, provider="rdap",
        status=STATUS_AVAILABLE, checked_at=earlier,
    ))
    session.commit()

    # Now stub the cascade so the CURRENT call returns 'error' (429),
    # mimicking the retry hitting a rate-limit AFTER the original
    # cascade succeeded. The runner should still persist 'available'.
    from app import availability_runner as runner_mod

    async def fake_cascade(domain, *, run_id, use_cache, client):
        # Append the error row the cascade would have written.
        s = runner_mod.SessionLocal()
        try:
            s.add(AvailabilityCheck(
                domain=domain, run_id=run_id, provider="rdap",
                status=STATUS_ERROR,
                checked_at=datetime(2026, 5, 17, 12, 5, 0),
                error_message="429",
            ))
            s.commit()
        finally:
            s.close()
        from app.availability_runner import check_availability_async
        # Mimic an AvailabilityResult shape — borrow the real dataclass.
        return type(
            "R", (), dict(
                domain=domain, status=STATUS_ERROR, provider="rdap",
                registrar="", expires_on=None, from_cache=False,
                checked_at=datetime(2026, 5, 17, 12, 5, 0),
            ),
        )()

    monkeypatch.setattr(runner_mod, "check_availability_async", fake_cascade)

    async def _run():
        async with httpx.AsyncClient() as client:
            await _process_availability_domain(rd.id, run.id, client)

    asyncio.run(_run())

    # Verdict must reflect the prior terminal answer, not the retry's
    # 429. Trace should include both attempts.
    cr = session.query(CriterionResult).filter_by(
        run_domain_id=rd.id, criterion="availability",
    ).one()
    body = json.loads(cr.data_json)
    assert body["verdict"]["status"] == STATUS_AVAILABLE, (
        f"Expected 'available' (preserved), got "
        f"{body['verdict']['status']!r}. Retry's 429 silently "
        "overwrote the prior good answer."
    )
    assert body["verdict"]["provider"] == "rdap"
    assert len(body["trace"]) == 2  # both the prior 'available' + the 429
    # The rd should also report 'done' (cascade completed cleanly; no
    # cascade_error raised), not 'failed'.
    session.refresh(rd)
    assert rd.status == "done"


def test_process_availability_run_batched(fresh_db, monkeypatch):
    """The batched main-run path (2026-06-21 throughput work). A run of N
    domains spread across several write-chunks must: mark every RD `done`,
    write exactly one availability CR (with the right verdict) + one trace
    row per domain, and write expiration back to BacklogDomain for the
    registered ones — i.e. the same observable result as the old
    per-domain path, produced in bulk."""
    from app import availability_runner as runner_mod
    from app.app_settings import set_availability_setting
    from app.availability.common import (
        ProviderResult,
        STATUS_AVAILABLE,
        STATUS_REGISTERED,
    )
    from app.models import (
        AvailabilityCheck,
        BacklogDomain,
        CriterionResult,
        Run,
        RunDomain,
    )

    # Single enabled provider → deterministic one-row trace per domain.
    set_availability_setting("availability__dns__enabled", "false")
    set_availability_setting("availability__rdap__enabled", "true")
    set_availability_setting("availability__domainr__enabled", "false")
    set_availability_setting("availability__whois__enabled", "false")
    set_availability_setting("availability__whoisfreaks__enabled", "false")

    # Tiny batch size so 5 domains span 3 chunks (exercises the chunk loop
    # + the bulk writers across boundaries). Also stub the auto-retry
    # scheduler so no background task outlives asyncio.run().
    monkeypatch.setattr(runner_mod, "_AV_WRITE_BATCH_SIZE", 2)
    monkeypatch.setattr(
        runner_mod, "schedule_availability_auto_retry", lambda run_id: None,
    )

    session = fresh_db
    run = Run(job_id=0, status="pending", spec_json="{}")
    session.add(run)
    session.flush()
    domains = [f"d{i}.com" for i in range(5)]
    rds = [
        RunDomain(run_id=run.id, domain=d, status="pending") for d in domains
    ]
    session.add_all(rds)
    session.commit()

    def _idx(domain: str) -> int:
        return int(domain.split(".", 1)[0][1:])

    async def fake_rdap(domain, client=None):
        # even index → registered (with expiry); odd → available.
        if _idx(domain) % 2 == 0:
            return ProviderResult(
                provider="rdap", status=STATUS_REGISTERED,
                registrar="R", expires_on=date(2030, 1, 1),
            )
        return ProviderResult(provider="rdap", status=STATUS_AVAILABLE)

    monkeypatch.setattr("app.availability.rdap.check", fake_rdap)

    asyncio.run(runner_mod.process_availability_run(run.id))

    session.expire_all()
    assert session.get(Run, run.id).status == "done"

    for rd in session.query(RunDomain).filter_by(run_id=run.id).all():
        assert rd.status == "done", f"{rd.domain} not done"
        assert rd.finished_at is not None
        cr = session.query(CriterionResult).filter_by(
            run_domain_id=rd.id, criterion="availability",
        ).one()
        assert cr.status == "done"
        body = json.loads(cr.data_json)
        expected = (
            STATUS_REGISTERED if _idx(rd.domain) % 2 == 0 else STATUS_AVAILABLE
        )
        assert body["verdict"]["status"] == expected
        assert len(body["trace"]) == 1
        assert body["trace"][0]["provider"] == "rdap"

    # One trace row per domain, all linked to this run.
    checks = session.query(AvailabilityCheck).all()
    assert len(checks) == len(domains)
    assert all(c.run_id == run.id for c in checks)

    # Registered domains got their expiration written back; available ones
    # have no expiry, so no backlog row is created for them.
    for d in domains:
        bd = session.query(BacklogDomain).filter_by(domain=d).one_or_none()
        if _idx(d) % 2 == 0:
            assert bd is not None, f"{d} should have a backlog row"
            assert bd.expiration_date == date(2030, 1, 1)
            assert bd.registrar == "R"
        else:
            assert bd is None, f"{d} (available) should not create a backlog row"


def test_reconcile_orphaned_running_run_domains(fresh_db):
    """B12 (2026-05-17): on startup, RDs stuck in status='running' with
    a terminal parent Run are zombie cascades from a uvicorn-restart-
    mid-flight. The reconciler must flip them to 'failed' so they show
    up correctly in the UI and the Retry-failed button can pick them
    up. Real partial data (data_json non-empty) is preserved untouched."""
    from app.main import _reconcile_orphaned_running_run_domains
    from app.models import CriterionResult, Run, RunDomain

    session = fresh_db
    # Setup: one terminal Run with three RDs to cover every case
    run_terminal = Run(job_id=0, status="done", spec_json="{}")
    # Active Run — RDs in it must NOT be touched
    run_active = Run(job_id=0, status="running", spec_json="{}")
    session.add_all([run_terminal, run_active])
    session.flush()

    # rd_orphan: stuck running on a terminal run + empty data_json — RESET
    rd_orphan = RunDomain(
        run_id=run_terminal.id, domain="orphan.example", status="running",
        started_at=datetime(2026, 5, 16, 8, 5, 0),
        finished_at=None,
    )
    # rd_active_running: stuck running BUT parent Run is active — KEEP
    rd_active_running = RunDomain(
        run_id=run_active.id, domain="active.example", status="running",
        started_at=datetime(2026, 5, 16, 12, 0, 0),
    )
    # rd_with_data: running on a terminal run BUT cr has data_json — KEEP
    # cr (real partial data). The rd itself still gets flipped to failed
    # because rd.status='running' under a terminal run is impossible-by-
    # invariant; the data CR is preserved untouched.
    rd_with_data = RunDomain(
        run_id=run_terminal.id, domain="hasdata.example", status="running",
        started_at=datetime(2026, 5, 16, 8, 6, 0),
    )
    session.add_all([rd_orphan, rd_active_running, rd_with_data])
    session.flush()

    cr_orphan = CriterionResult(
        run_domain_id=rd_orphan.id, criterion="availability",
        status="running", data_json="", error="",
    )
    cr_active = CriterionResult(
        run_domain_id=rd_active_running.id, criterion="availability",
        status="running", data_json="", error="",
    )
    cr_partial = CriterionResult(
        run_domain_id=rd_with_data.id, criterion="availability",
        status="running",
        data_json='{"verdict": {"status": "registered"}}',
        error="",
    )
    session.add_all([cr_orphan, cr_active, cr_partial])
    session.commit()

    flipped = _reconcile_orphaned_running_run_domains()
    assert flipped == 2, f"expected 2 flips, got {flipped}"

    session.expire_all()
    # rd_orphan: now failed; cr_orphan: now failed (empty data_json)
    assert session.get(RunDomain, rd_orphan.id).status == "failed"
    assert "orphaned" in session.get(RunDomain, rd_orphan.id).error
    assert session.get(CriterionResult, cr_orphan.id).status == "failed"
    # rd_active_running untouched
    assert session.get(RunDomain, rd_active_running.id).status == "running"
    assert session.get(CriterionResult, cr_active.id).status == "running"
    # rd_with_data: rd flipped, but its data-carrying CR is preserved
    assert session.get(RunDomain, rd_with_data.id).status == "failed"
    cr_after = session.get(CriterionResult, cr_partial.id)
    assert cr_after.status == "running", (
        "CR with real data_json must not be touched"
    )
    assert cr_after.data_json == '{"verdict": {"status": "registered"}}'

    # Idempotent — second call flips nothing
    flipped2 = _reconcile_orphaned_running_run_domains()
    assert flipped2 == 0


# --- Registrable-domain trimming for availability jobs (2026-06-21) ----------

def test_registrable_domain_trims_urls_to_etld1(fresh_db):
    """`registrable_domain` reduces URLs / hosts / subdomains to the eTLD+1
    that an availability check is meaningful for, preserving private + ICANN
    multilabel suffixes and falling back to the host for unresolvable
    inputs."""
    from app.availability.suffix import registrable_domain
    cases = {
        "example.com": "example.com",
        "https://example.com/page?q=1": "example.com",
        "http://www.example.com/": "example.com",
        "WWW.Example.COM": "example.com",
        "blog.example.com": "example.com",
        "https://shop.example.co.uk/cart?x=1": "example.co.uk",
        "a.b.example.co.uk": "example.co.uk",
        "user:pass@example.com:8443/x": "example.com",
        "example.com?utm=1": "example.com",          # query, no path
        "jcg.us.com": "jcg.us.com",                  # private suffix kept whole
        "www.example.com.ua": "example.com.ua",      # ICANN multilabel kept
        "": "",
        "   ": "",
        "localhost": "localhost",                    # PSL None → host fallback
        "127.0.0.1": "127.0.0.1",
    }
    for raw, expected in cases.items():
        got = registrable_domain(raw)
        assert got == expected, f"{raw!r} -> {got!r}, expected {expected!r}"


def test_submit_availability_job_trims_and_dedupes(fresh_db, monkeypatch):
    """The availability submit endpoint stores TRIMMED, DEDUPED registrable
    domains as RunDomains — not the raw URLs/subdomains the operator pasted."""
    import asyncio
    from app.models import Run, RunDomain
    from app.routers import analyze
    from app.routers.analyze import (
        SubmitAvailabilityIn,
        submit_availability_job,
    )

    session = fresh_db
    # Don't spawn the real runner/cascade from the test.
    monkeypatch.setattr(analyze, "dispatch_run", lambda run_id: None)

    payload = SubmitAvailabilityIn(domains=[
        "https://example.com/page?a=1",
        "http://www.example.com/",       # dup of example.com
        "blog.example.com",              # dup (subdomain → example.com)
        "shop.example.co.uk/cart",
        "  EXAMPLE.com  ",               # dup (whitespace + case)
        "",                              # dropped (empty)
    ])
    out = asyncio.run(submit_availability_job(payload, db=session))

    stored = sorted(
        rd.domain for rd in
        session.query(RunDomain).filter_by(run_id=out.run_id).all()
    )
    assert stored == ["example.co.uk", "example.com"], stored
    # And the persisted spec carries the same trimmed set.
    run = session.get(Run, out.run_id)
    spec_domains = sorted(json.loads(run.spec_json)["domains"])
    assert spec_domains == ["example.co.uk", "example.com"]
