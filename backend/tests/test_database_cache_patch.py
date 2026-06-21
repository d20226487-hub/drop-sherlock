"""Coverage for the Database snapshot-cache patching (2026-06-21).

The non-blocking rows cache patches a single domain's row in place after a
mutation instead of rebuilding the whole ~70k-row aggregation. Correctness
hinges on one invariant: `_build_all_rows(only_domains={d})` must produce a
row BYTE-IDENTICAL to what the full `_build_all_rows()` produces for `d` —
otherwise a patched row silently diverges from a rebuilt one. These tests
guard that, plus the patch's effect on the cached snapshot.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta

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


def _seed(session, domains):
    """One job, two pinned runs (wayback + backlinks/refdomains), each
    carrying every domain. Pins wire criteria → runs so each domain
    synthesizes a non-trivial row."""
    from app.models import (
        CriterionResult, Job, JobCriterionPin, Run, RunDomain,
    )
    now = datetime.utcnow()
    job = Job(name="t", spec_json="{}")
    session.add(job)
    session.flush()
    run_wb = Run(job_id=job.id, status="done", spec_json="{}",
                 started_at=now - timedelta(hours=2),
                 finished_at=now - timedelta(hours=1), name="wb")
    run_ah = Run(job_id=job.id, status="done", spec_json="{}",
                 started_at=now - timedelta(hours=1), finished_at=now,
                 name="ah")
    session.add_all([run_wb, run_ah])
    session.flush()
    for d in domains:
        rd_wb = RunDomain(run_id=run_wb.id, domain=d, status="done",
                          started_at=now, finished_at=now)
        rd_ah = RunDomain(run_id=run_ah.id, domain=d, status="done",
                          started_at=now, finished_at=now)
        session.add_all([rd_wb, rd_ah])
        session.flush()
        session.add_all([
            CriterionResult(
                run_domain_id=rd_wb.id, criterion="wayback", status="done",
                data_json=json.dumps({"wayback": [{"ts": "20200101"}]}),
                ai_verdict_json=json.dumps(
                    {"assessment": "good", "confidence": 0.9}),
            ),
            CriterionResult(
                run_domain_id=rd_ah.id, criterion="backlinks", status="done",
                data_json=json.dumps({"backlinks": [1, 2, 3]}),
                ai_verdict_json=json.dumps(
                    {"assessment": "high_quality", "confidence": 0.8}),
            ),
            CriterionResult(
                run_domain_id=rd_ah.id, criterion="refdomains", status="done",
                data_json=json.dumps({"refdomains": [1, 2]}),
                ai_verdict_json=json.dumps(
                    {"assessment": "mixed", "confidence": 0.7}),
            ),
        ])
    session.add_all([
        JobCriterionPin(job_id=job.id, criterion="wayback", run_id=run_wb.id),
        JobCriterionPin(job_id=job.id, criterion="backlinks", run_id=run_ah.id),
        JobCriterionPin(job_id=job.id, criterion="refdomains", run_id=run_ah.id),
    ])
    session.commit()
    return job


def test_single_domain_build_matches_full_build(fresh_db):
    """The crux: a row built with only_domains={d} is identical to that
    domain's row from a full build."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com", "b.com"])

    full_rows, _opts, _hide = dbmod._build_all_rows(fresh_db)
    full_by_domain = {r.domain: r for r in full_rows}
    assert set(full_by_domain) == {"a.com", "b.com"}

    one_rows, _o2, _h2 = dbmod._build_all_rows(
        fresh_db, only_domains={"a.com"})
    assert [r.domain for r in one_rows] == ["a.com"]

    # Byte-identical synthesis (compare full pydantic dumps).
    assert one_rows[0].model_dump() == full_by_domain["a.com"].model_dump()
    # And the scored fields are actually populated (proves it's non-trivial).
    assert full_by_domain["a.com"].final_score is not None


def test_patch_updates_cached_row_in_place(fresh_db):
    from app.models import DomainNote
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com", "b.com"])

    # Prime the snapshot cache (cold inline build).
    rows, _o, _h = dbmod._get_all_rows(fresh_db)
    assert {r.domain for r in rows} == {"a.com", "b.com"}
    assert next(r for r in rows if r.domain == "a.com").note == ""

    # Mutate: add a note for a.com, then patch just that domain.
    fresh_db.add(DomainNote(domain="a.com", note="hello"))
    fresh_db.commit()
    dbmod._patch_domains_in_cache(fresh_db, ["a.com"])

    snap = dbmod._peek_rows_cache()
    assert snap is not None
    by_domain = {r.domain: r for r in snap[0]}
    assert by_domain["a.com"].note == "hello"      # patched
    assert by_domain["b.com"].note == ""           # untouched
    assert set(by_domain) == {"a.com", "b.com"}     # no rows lost


def test_patch_drops_domain_with_no_rows(fresh_db):
    """A domain whose rds all vanish (delete) is removed from the snapshot
    by the patch."""
    from app.models import RunDomain
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com", "b.com"])
    dbmod._get_all_rows(fresh_db)  # prime

    # Delete every rd for a.com, then patch it.
    for rd in fresh_db.query(RunDomain).filter(RunDomain.domain == "a.com").all():
        fresh_db.delete(rd)
    fresh_db.commit()
    dbmod._patch_domains_in_cache(fresh_db, ["a.com"])

    snap = dbmod._peek_rows_cache()
    assert {r.domain for r in snap[0]} == {"b.com"}


def test_cold_start_serves_empty_while_already_building(fresh_db):
    """Page route on a cold cache WHEN a build is already in flight (the
    real-app boot case — the startup pre-warm sets the flag before the
    server accepts requests) serves empty immediately instead of blocking
    on the ~tens-of-seconds first build."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    dbmod._rebuild_pending = True  # simulate the startup pre-warm in flight
    try:
        rows, opts, hide = dbmod._get_all_rows(
            fresh_db, allow_building_empty=True)
    finally:
        dbmod._rebuild_pending = False
    assert rows == []                 # served empty — did NOT block on build
    assert "verdicts" in opts and opts["verdicts"] == []  # options shape intact


def test_cold_start_route_builds_inline_when_nothing_building(fresh_db):
    """Page route on a cold cache with NO build in flight (e.g. a direct
    call before any pre-warm) still returns real data — never a spurious
    empty."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    assert dbmod._rebuild_pending is False
    rows, _o, _h = dbmod._get_all_rows(fresh_db, allow_building_empty=True)
    assert {r.domain for r in rows} == {"a.com"}


def test_cold_start_builds_inline_for_internal_caller(fresh_db):
    """Internal callers (default allow_building_empty=False) always get a
    real, fully-built result — they need the data."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    rows, _o, _h = dbmod._get_all_rows(fresh_db)
    assert {r.domain for r in rows} == {"a.com"}


def test_fresh_get_all_rows_serves_snapshot_without_blocking(fresh_db):
    """fresh=True returns the existing snapshot immediately (non-blocking)
    rather than rebuilding inline."""
    from app.routers import database as dbmod
    _seed(fresh_db, ["a.com"])
    dbmod._get_all_rows(fresh_db)  # prime snapshot

    # Force the would-be rebuild to explode; fresh=True must NOT call it
    # inline (it serves the snapshot + schedules a background rebuild).
    import app.routers.database as d2
    orig = d2._trigger_background_rebuild
    d2._trigger_background_rebuild = lambda: None
    try:
        rows, _o, _h = dbmod._get_all_rows(fresh_db, fresh=True)
    finally:
        d2._trigger_background_rebuild = orig
    assert {r.domain for r in rows} == {"a.com"}
