"""Database snapshot refreshes slowly while Wayback / Availability checks
run (2026-11-01).

A full snapshot rebuild is the heaviest thing the API does (~2 GB extra at
~100k domains, measured), and it competes with those checks for the one
Python process. While one is running or being retried, the snapshot
refreshes at most every 30 min instead of 5: the TTL stretches and rebuild
requests fold into one deferred rebuild. Per-row patches stay instant, and
the list response reports the mode for the page's banner.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from datetime import datetime

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
        db_mod.engine.dispose()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@pytest.fixture
def dbr(fresh_db, monkeypatch):
    """The database router with clean module state and builds/timers
    recorded instead of run."""
    from app.routers import database as dbr
    monkeypatch.setattr(dbr, "_checks_probe", (0.0, []))
    monkeypatch.setattr(dbr, "_rows_cache", {})
    monkeypatch.setattr(dbr, "_last_build_done", 0.0)
    monkeypatch.setattr(dbr, "_deferred_rebuild", None)
    monkeypatch.setattr(dbr, "_rebuild_pending", False)
    return dbr


AVAIL_SPEC = json.dumps({"criteria": {"availability": {"enabled": True}}})
WAYBACK_SPEC = json.dumps({"criteria": {"wayback": {"enabled": True}}})
AHREFS_SPEC = json.dumps({"criteria": {"backlinks": {"enabled": True}}})


def _run(db, kind, spec, status):
    from app.models import Job, Run
    job = Job(name=kind, notes="", spec_json=spec, kind=kind)
    db.add(job)
    db.flush()
    run = Run(job_id=job.id, status=status, spec_json=spec, error="")
    db.add(run)
    db.commit()
    return job.id, run.id


class _Live:
    def done(self):
        return False


class _Finished:
    def done(self):
        return True


def test_detects_running_and_retrying_wayback_and_availability(fresh_db, dbr):
    from app import tasks
    a_job, a_run = _run(fresh_db, "availability", AVAIL_SPEC, "running")
    w_job, w_run = _run(fresh_db, "quality", WAYBACK_SPEC, "running")
    _run(fresh_db, "quality", AHREFS_SPEC, "running")          # no wayback: light
    _run(fresh_db, "availability", AVAIL_SPEC, "done")         # finished
    r_job, r_run = _run(fresh_db, "quality", WAYBACK_SPEC, "done")
    _, stale_run = _run(fresh_db, "availability", AVAIL_SPEC, "done")
    tasks._REANALYZING_RUNS[r_run] = _Live()        # Retry failed / auto-retry
    tasks._REANALYZING_RUNS[stale_run] = _Finished()
    try:
        checks = dbr.active_heavy_checks()
    finally:
        tasks._REANALYZING_RUNS.pop(r_run, None)
        tasks._REANALYZING_RUNS.pop(stale_run, None)
    assert checks == [
        {"run_id": a_run, "job_id": a_job, "kind": "availability"},
        {"run_id": w_run, "job_id": w_job, "kind": "wayback"},
        {"run_id": r_run, "job_id": r_job, "kind": "wayback"},
    ]


def test_probe_result_is_cached(fresh_db, dbr, monkeypatch):
    calls = []
    monkeypatch.setattr(dbr, "_probe_heavy_checks", lambda: calls.append(1) or [])
    for _ in range(5):
        dbr.active_heavy_checks()
    assert len(calls) == 1


def _age_snapshot(dbr, seconds):
    """Pretend the stored snapshot was built `seconds` ago."""
    exp, rows, opts, hide = dbr._rows_cache["all"]
    dbr._rows_cache["all"] = (time.monotonic() - seconds + dbr._ROWS_CACHE_TTL_SEC,
                              rows, opts, hide)


CHECKS = [{"run_id": 1, "job_id": 1, "kind": "availability"}]


def test_ttl_stretches_to_30_min_only_while_checks_run(dbr, monkeypatch):
    dbr._store_rows_cache([], {}, set())
    _age_snapshot(dbr, 600)                      # 10 min old: past the 5-min TTL
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: [])
    assert dbr._read_rows_cache(time.monotonic()) is None
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: CHECKS)
    assert dbr._read_rows_cache(time.monotonic()) is not None
    _age_snapshot(dbr, 31 * 60)                  # past the slow window too
    assert dbr._read_rows_cache(time.monotonic()) is None


class _FakeTimer:
    started: list = []

    def __init__(self, wait, fn):
        self.wait, self.fn, self.daemon, self.name = wait, fn, False, ""

    def start(self):
        _FakeTimer.started.append(self)

    def is_alive(self):
        return self in _FakeTimer.started


def _record_builds(dbr, monkeypatch):
    builds = []
    monkeypatch.setattr(dbr, "_build_and_store_rows", lambda: builds.append(1))
    monkeypatch.setattr(dbr.threading, "Timer", _FakeTimer)
    _FakeTimer.started = []
    return builds


def _wait_idle(dbr):
    for _ in range(100):
        if not dbr._rebuild_pending:
            return
        time.sleep(0.01)


def test_rebuild_requests_fold_into_one_deferred_rebuild(dbr, monkeypatch):
    builds = _record_builds(dbr, monkeypatch)
    dbr._store_rows_cache([], {}, set())         # just built
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: CHECKS)
    for _ in range(3):                           # bulk edits, pins, Refresh
        dbr._invalidate_rows_cache()
    _wait_idle(dbr)
    assert builds == []
    assert len(_FakeTimer.started) == 1
    assert 1790 < _FakeTimer.started[0].wait <= 1800
    # When the window ends the deferred rebuild runs.
    _age_snapshot(dbr, 1801)
    dbr._last_build_done = time.monotonic() - 1801
    _FakeTimer.started[0].fn()
    _wait_idle(dbr)
    assert builds == [1]


def test_no_deferral_without_checks_or_without_a_snapshot(dbr, monkeypatch):
    builds = _record_builds(dbr, monkeypatch)
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: CHECKS)
    dbr._invalidate_rows_cache()                 # cold: nothing to serve yet
    _wait_idle(dbr)
    assert builds == [1] and _FakeTimer.started == []
    dbr._store_rows_cache([], {}, set())
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: [])
    dbr._invalidate_rows_cache()                 # checks over: normal behaviour
    _wait_idle(dbr)
    assert builds == [1, 1] and _FakeTimer.started == []


def test_list_response_reports_the_mode(fresh_db, dbr, monkeypatch):
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: CHECKS)
    out = dbr.list_domains(db=fresh_db, offset=0, limit=10)
    assert out.slow_refresh is True
    assert out.slow_refresh_checks == CHECKS
    assert out.refresh_interval_min == 30
    built = datetime.strptime(out.snapshot_built_at, "%Y-%m-%dT%H:%M:%SZ")
    assert abs((datetime.utcnow() - built).total_seconds()) < 60
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: [])
    out = dbr.list_domains(db=fresh_db, offset=0, limit=10)
    assert out.slow_refresh is False and out.refresh_interval_min == 5


def test_move_to_source_shows_on_rows_even_when_rebuild_is_deferred(
    fresh_db, dbr, monkeypatch,
):
    from app.models import BacklogDomain, CriterionResult, Job, Run, RunDomain
    job = Job(name="q", notes="", spec_json="{}", kind="quality")
    fresh_db.add(job)
    fresh_db.flush()
    run = Run(job_id=job.id, status="done", spec_json="{}", error="")
    fresh_db.add(run)
    fresh_db.flush()
    rd = RunDomain(run_id=run.id, domain="moved.kz", status="done", error="")
    fresh_db.add(rd)
    fresh_db.flush()
    fresh_db.add(CriterionResult(run_domain_id=rd.id, criterion="availability",
                                 status="done", request_url="", error="",
                                 data_json=json.dumps({"verdict": {"status": "available"}})))
    fresh_db.add(BacklogDomain(domain="moved.kz", registrar="old-src"))
    fresh_db.commit()
    dbr.list_domains(db=fresh_db, offset=0, limit=10)       # builds the snapshot
    row = next(r for r in dbr._peek_rows_cache()[0] if r.domain == "moved.kz")
    assert row.backlog_registrar == "old-src"

    builds = _record_builds(dbr, monkeypatch)
    monkeypatch.setattr(dbr, "active_heavy_checks", lambda: CHECKS)
    dbr.bulk_set_source(dbr.BulkSetSourceIn(domains=["moved.kz"], source="new-src"),
                        fresh_db)
    _wait_idle(dbr)
    assert builds == [] and len(_FakeTimer.started) == 1     # rebuild deferred
    row = next(r for r in dbr._peek_rows_cache()[0] if r.domain == "moved.kz")
    assert row.backlog_registrar == "new-src"                # row already moved
