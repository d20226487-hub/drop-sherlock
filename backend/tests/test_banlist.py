"""Coverage for the domain ban list (2026-05-13 wave L).

Pins the cross-cutting "all four BacklogDomain insertion sites + Analyze
submit reject banned domains" property. This is the leaky-risk part of
the feature — if any insertion path ever forgets to call the ban filter,
the ban list is silently broken. These tests are the regression net.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import date, datetime

import pytest


@pytest.fixture
def fresh_db(monkeypatch):
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


def _client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def _ban(session, domain: str, note: str = "") -> None:
    from app.models import DomainBan
    session.add(DomainBan(domain=domain, note=note, created_at=datetime.utcnow()))
    session.commit()


# --- /banlist CRUD ---------------------------------------------------------


def test_banlist_add_normalizes_and_dedupes(fresh_db):
    client = _client()
    resp = client.post(
        "/banlist",
        auth=("admin", "changeme"),
        json={
            "rows": [
                {"domain": "Example.COM", "note": "first"},
                {"domain": "https://example.com/path", "note": "dup"},
                {"domain": "other.kz", "note": ""},
                {"domain": "", "note": "blank"},
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["added"] == 2  # example.com + other.kz (the second example.com is intra-payload dup)
    assert data["invalid"] == 1  # the empty-domain row
    # `already_banned` may include intra-payload dupes — the contract is
    # only that "added + already_banned + invalid sum reflects the payload"
    # within reason. Just verify added == 2.

    resp = client.get("/banlist", auth=("admin", "changeme"))
    domains = sorted(r["domain"] for r in resp.json()["rows"])
    assert domains == ["example.com", "other.kz"]


def test_banlist_delete_idempotent(fresh_db):
    _ban(fresh_db, "ban-me.kz")
    client = _client()
    r = client.delete("/banlist/ban-me.kz", auth=("admin", "changeme"))
    assert r.status_code == 200
    # Second delete is a 404 — caller can suppress.
    r = client.delete("/banlist/ban-me.kz", auth=("admin", "changeme"))
    assert r.status_code == 404


# --- Insertion site #1: backlog import -------------------------------------


def test_backlog_import_rejects_banned(fresh_db):
    from app.models import BacklogDomain

    _ban(fresh_db, "bad.kz")
    client = _client()
    resp = client.post(
        "/backlog/import",
        auth=("admin", "changeme"),
        json={
            "rows": [
                {"domain": "good.kz"},
                {"domain": "bad.kz"},
                {"domain": "BAD.kz"},  # case dup of bad.kz
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["inserted"] == 1  # only good.kz
    assert body["skipped_banned"] == 1  # bad.kz hits the ban filter

    domains = {b.domain for b in fresh_db.query(BacklogDomain).all()}
    assert domains == {"good.kz"}


# --- Insertion site #2: per-row Order/Discard upsert -----------------------


def test_database_single_row_upsert_rejects_create_of_banned(fresh_db):
    """If the domain isn't in BacklogDomain yet AND is banned, the
    per-row upsert returns 409. If it IS in BacklogDomain already, the
    update succeeds (per design call (a) — banning is pre-filter only)."""
    from app.models import BacklogDomain

    _ban(fresh_db, "banned-new.kz")
    # Pre-existing row for a different banned domain → update should succeed.
    fresh_db.add(BacklogDomain(
        domain="banned-existing.kz",
        status="backlog",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    ))
    _ban(fresh_db, "banned-existing.kz")
    fresh_db.commit()

    client = _client()

    # New + banned → 409.
    r = client.post(
        "/database/domains/banned-new.kz/backlog-status",
        auth=("admin", "changeme"),
        json={"status": "order"},
    )
    assert r.status_code == 409

    # Existing + banned → status updates fine.
    r = client.post(
        "/database/domains/banned-existing.kz/backlog-status",
        auth=("admin", "changeme"),
        json={"status": "discarded"},
    )
    assert r.status_code == 200
    fresh_db.expire_all()
    existing = fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "banned-existing.kz",
    ).one()
    assert existing.status == "discarded"


# --- Insertion site #3: bulk Order/Discard upsert --------------------------


def test_database_bulk_upsert_skips_create_of_banned(fresh_db):
    """Bulk variant: creates skip banned, existing rows update normally."""
    from app.models import BacklogDomain

    _ban(fresh_db, "banned-new.kz")
    fresh_db.add(BacklogDomain(
        domain="banned-existing.kz",
        status="backlog",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    ))
    _ban(fresh_db, "banned-existing.kz")
    fresh_db.commit()

    client = _client()
    r = client.post(
        "/database/domains/bulk-backlog-status",
        auth=("admin", "changeme"),
        json={
            "domains": [
                "fresh.kz",            # creates a new row, allowed
                "banned-new.kz",       # would create — banned, skipped
                "banned-existing.kz",  # updates existing — allowed
            ],
            "status": "order",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 1
    assert body["updated"] == 1
    assert body["skipped_banned"] == 1

    domains = {b.domain for b in fresh_db.query(BacklogDomain).all()}
    assert domains == {"fresh.kz", "banned-existing.kz"}


# --- Insertion site #4: availability cascade auto-upsert -------------------


def test_availability_cascade_skips_banned_create(fresh_db, monkeypatch):
    """When the availability cascade returns expires_on, the runner
    auto-upserts a BacklogDomain. If the domain is banned AND has no
    existing row, that auto-create must be skipped."""
    from app.models import BacklogDomain, Run, RunDomain, Job
    from app import tasks

    _ban(fresh_db, "banned-avail.kz")
    job = Job(name="t", spec_json="{}")
    fresh_db.add(job); fresh_db.flush()
    run = Run(job_id=job.id, status="running", spec_json="{}")
    fresh_db.add(run); fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="banned-avail.kz", status="running")
    fresh_db.add(rd); fresh_db.flush()
    fresh_db.commit()

    # Monkeypatch the cascade so we don't hit real network.
    from app.availability.cascade import AvailabilityResult
    async def fake_check(domain, *, run_id):
        return AvailabilityResult(
            domain=domain,
            status="registered",
            registrar="Reg Inc",
            expires_on=date(2030, 1, 1),
            checked_at=datetime.utcnow(),
            provider="rdap",
        )
    # The runner imports check_availability_async locally inside
    # _run_availability_for_domain, so patch the source module rather
    # than the tasks module.
    from app import availability as availability_pkg
    monkeypatch.setattr(
        availability_pkg, "check_availability_async", fake_check,
    )
    # Skip-policy lookup is also imported locally — patch its module.
    from app import app_settings as app_settings_mod
    monkeypatch.setattr(
        app_settings_mod, "get_skip_registered_policy",
        lambda: {"enabled": False, "horizon_days": 30},
    )

    import asyncio
    asyncio.run(tasks._run_availability_for_domain(
        run_domain_id=rd.id, domain="banned-avail.kz", run_id=run.id,
    ))

    # No BacklogDomain row should exist for the banned domain.
    fresh_db.expire_all()
    count = fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "banned-avail.kz",
    ).count()
    assert count == 0, "banned domain auto-upserted via availability cascade"


# --- Insertion site #5: Analyze submit (per design call β) ----------------


def test_analyze_submit_rejects_banned(fresh_db):
    _ban(fresh_db, "banned1.kz")
    _ban(fresh_db, "banned2.kz")
    client = _client()
    r = client.post(
        "/analyze/jobs",
        auth=("admin", "changeme"),
        json={
            "spec": {
                "domains": [
                    "good.kz",
                    "banned1.kz",
                    "BANNED2.kz",
                ],
                "criteria": {
                    "backlinks": {"enabled": True, "limit": 10, "mode": "live"},
                    "refdomains": {"enabled": False},
                    "anchors": {"enabled": False},
                    "keywords": {"enabled": False},
                    "wayback": {"enabled": False},
                    "wayback_classify": {"enabled": False},
                },
                "ai": {"provider": "gemini", "model": "test"},
                "lang": "en",
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert sorted(body["skipped_banned"]) == sorted(["banned1.kz", "BANNED2.kz"])
    # Job + run were still created with only the surviving domain.
    from app.models import RunDomain
    rds = fresh_db.query(RunDomain).filter(RunDomain.run_id == body["run_id"]).all()
    assert [rd.domain for rd in rds] == ["good.kz"]


def test_analyze_submit_400_when_every_domain_banned(fresh_db):
    _ban(fresh_db, "x.kz")
    client = _client()
    r = client.post(
        "/analyze/jobs",
        auth=("admin", "changeme"),
        json={
            "spec": {
                "domains": ["x.kz"],
                "criteria": {
                    "backlinks": {"enabled": True, "limit": 10, "mode": "live"},
                    "refdomains": {"enabled": False},
                    "anchors": {"enabled": False},
                    "keywords": {"enabled": False},
                    "wayback": {"enabled": False},
                    "wayback_classify": {"enabled": False},
                },
                "ai": {"provider": "gemini", "model": "test"},
            },
        },
    )
    assert r.status_code == 400
    assert "banned" in r.text.lower()


# --- Database row exposure -------------------------------------------------


def test_database_domains_exposes_is_banned(fresh_db):
    """A row whose domain is on the ban list should come back from
    /database/domains with is_banned=True (drives the row badge)."""
    from app.models import Job, Run, RunDomain
    job = Job(name="t", spec_json="{}")
    fresh_db.add(job); fresh_db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}")
    fresh_db.add(run); fresh_db.flush()
    fresh_db.add(RunDomain(run_id=run.id, domain="banned.kz", status="done"))
    fresh_db.add(RunDomain(run_id=run.id, domain="ok.kz", status="done"))
    _ban(fresh_db, "banned.kz")
    fresh_db.commit()

    client = _client()
    r = client.get("/database/domains", auth=("admin", "changeme"))
    assert r.status_code == 200
    by_domain = {row["domain"]: row for row in r.json()["rows"]}
    assert by_domain["banned.kz"]["is_banned"] is True
    assert by_domain["ok.kz"].get("is_banned", False) is False
