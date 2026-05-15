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


def test_backlog_delete_does_not_remove_ban(fresh_db):
    """The two tables are independent (no FK, no cascade). Deleting a
    BacklogDomain row must NEVER touch the corresponding DomainBan row.
    Pinned by this test so a future "convenience cascade" refactor
    can't quietly break the invariant."""
    from app.models import BacklogDomain, DomainBan

    # Set up: one domain that's both in the backlog AND on the ban list.
    fresh_db.add(BacklogDomain(
        domain="dual.kz",
        status="discarded",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    ))
    _ban(fresh_db, "dual.kz", note="permanent")
    fresh_db.commit()
    backlog_id = (
        fresh_db.query(BacklogDomain)
        .filter(BacklogDomain.domain == "dual.kz")
        .one()
        .id
    )

    # Delete via the bulk-delete endpoint (the only delete path).
    client = _client()
    r = client.post(
        "/backlog/bulk-delete",
        auth=("admin", "changeme"),
        json={"ids": [backlog_id]},
    )
    assert r.status_code == 200
    assert r.json()["deleted"] == 1

    # Backlog row gone — ban survives.
    fresh_db.expire_all()
    assert fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "dual.kz",
    ).count() == 0
    ban = fresh_db.query(DomainBan).filter(
        DomainBan.domain == "dual.kz",
    ).one_or_none()
    assert ban is not None, "DomainBan was removed when BacklogDomain was deleted"
    assert ban.note == "permanent"  # the original note survives unchanged


def test_banning_snapshots_and_deletes_backlog_row(fresh_db):
    """Locked 2026-05-14 (supersedes wave-O β): adding a domain to the
    ban list while it already has a BacklogDomain row captures a JSON
    snapshot of the row onto the new DomainBan and deletes the
    Backlog row. The user no longer sees the row in Backlog — and the
    snapshot is what makes unban able to fully restore it."""
    import json

    from app.models import BacklogDomain, DomainBan

    fresh_db.add(BacklogDomain(
        domain="flip-me.kz",
        status="analyzed",
        registrar="example-reg",
        comments="keep me",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    ))
    fresh_db.commit()

    client = _client()
    r = client.post(
        "/banlist",
        auth=("admin", "changeme"),
        json={"rows": [{"domain": "flip-me.kz", "note": "junk"}]},
    )
    assert r.status_code == 200
    assert r.json()["added"] == 1

    fresh_db.expire_all()
    assert fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "flip-me.kz",
    ).count() == 0, "Backlog row should be deleted when banned"

    ban = fresh_db.query(DomainBan).filter(
        DomainBan.domain == "flip-me.kz",
    ).one()
    snapshot = json.loads(ban.backlog_snapshot_json)
    assert snapshot["status"] == "analyzed"
    assert snapshot["registrar"] == "example-reg"
    assert snapshot["comments"] == "keep me"


def test_banning_no_op_when_no_backlog_row(fresh_db):
    """If the banned domain has no BacklogDomain row, the ban succeeds
    with an EMPTY snapshot and no backlog row is created. Unban of such
    a row has nothing to restore (covered by the next test)."""
    from app.models import BacklogDomain, DomainBan

    client = _client()
    r = client.post(
        "/banlist",
        auth=("admin", "changeme"),
        json={"rows": [{"domain": "no-row.kz", "note": ""}]},
    )
    assert r.status_code == 200
    assert r.json()["added"] == 1
    assert fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "no-row.kz",
    ).count() == 0
    ban = fresh_db.query(DomainBan).filter(
        DomainBan.domain == "no-row.kz",
    ).one()
    assert ban.backlog_snapshot_json == "", (
        "no Backlog row existed at ban time — snapshot must stay empty so "
        "unban knows not to fabricate a restore"
    )


def test_unbanning_restores_backlog_row_from_snapshot(fresh_db):
    """Locked 2026-05-14: unban is the symmetric inverse of ban for
    the row's data (registrar / expiration / comments / prices), but
    the restored row's status is forced to 'banned' so the user can
    find it under Status=Banned and re-status manually if they want
    it back in the active triage flow."""
    from datetime import date

    from app.models import BacklogDomain

    fresh_db.add(BacklogDomain(
        domain="ping-pong.kz",
        status="discarded",
        registrar="reg-x",
        expiration_date=date(2027, 1, 15),
        comments="original note",
        desired_price=10.5,
        max_price=20.0,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    ))
    fresh_db.commit()

    client = _client()
    # Ban → Backlog row deleted.
    client.post(
        "/banlist",
        auth=("admin", "changeme"),
        json={"rows": [{"domain": "ping-pong.kz", "note": ""}]},
    )
    fresh_db.expire_all()
    assert fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "ping-pong.kz",
    ).count() == 0

    # Unban → Backlog row restored with original DATA fields; status
    # forced to 'banned'.
    r = client.delete(
        "/banlist/ping-pong.kz", auth=("admin", "changeme"),
    )
    assert r.status_code == 200
    assert r.json().get("restored") is True
    fresh_db.expire_all()
    row = fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain == "ping-pong.kz",
    ).one()
    assert row.status == "banned"
    assert row.registrar == "reg-x"
    assert row.expiration_date == date(2027, 1, 15)
    assert row.comments == "original note"
    assert row.desired_price == 10.5
    assert row.max_price == 20.0


def test_bulk_unbanning_restores_backlog_rows(fresh_db):
    """Bulk-delete path mirrors the single-domain restore."""
    from app.models import BacklogDomain

    for d in ("a.kz", "b.kz"):
        fresh_db.add(BacklogDomain(
            domain=d,
            status="analyzed",
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        ))
    fresh_db.commit()

    client = _client()
    client.post(
        "/banlist",
        auth=("admin", "changeme"),
        json={"rows": [{"domain": "a.kz"}, {"domain": "b.kz"}]},
    )
    fresh_db.expire_all()
    assert fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain.in_(["a.kz", "b.kz"]),
    ).count() == 0

    r = client.post(
        "/banlist/bulk-delete",
        auth=("admin", "changeme"),
        json={"domains": ["a.kz", "b.kz"]},
    )
    assert r.status_code == 200
    assert r.json()["deleted"] == 2
    fresh_db.expire_all()
    rows = fresh_db.query(BacklogDomain).filter(
        BacklogDomain.domain.in_(["a.kz", "b.kz"]),
    ).all()
    assert {r.domain for r in rows} == {"a.kz", "b.kz"}
    # Restored rows are forced to status='banned' — see the single-
    # domain test for rationale.
    assert all(r.status == "banned" for r in rows)


def test_backlog_import_surfaces_skipped_banned_count(fresh_db):
    """Wave-O surfaces `skipped_banned` in the import-result UI. The
    backend was already returning it (added wave L); this test pins the
    schema field stays present + non-zero when something is filtered."""
    _ban(fresh_db, "blocked.kz")
    client = _client()
    r = client.post(
        "/backlog/import",
        auth=("admin", "changeme"),
        json={
            "rows": [
                {"domain": "good.kz"},
                {"domain": "blocked.kz"},
            ],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "skipped_banned" in body
    assert body["skipped_banned"] == 1
    assert body["inserted"] == 1


def test_database_domains_hides_banned(fresh_db):
    """Revised 2026-05-15: banned domains are HIDDEN from the
    /database/domains listing (was: stay visible with is_banned=True).
    The underlying rds + CRs are not deleted — unbanning restores the
    row on the next reload. Audit links to prior analyses are surfaced
    on the /banlist page instead.
    """
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
    # banned.kz is filtered out; ok.kz remains.
    assert "banned.kz" not in by_domain
    assert "ok.kz" in by_domain
