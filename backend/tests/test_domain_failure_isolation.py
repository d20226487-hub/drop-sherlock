"""Coverage for containing a single domain's failure in a quality run
(added 2026-10-30).

`process_run` fans out with `asyncio.gather(..., return_exceptions=False)`,
so the FIRST exception from ANY domain used to fail the whole run — and
gather does not cancel the siblings, which kept fetching into a run already
marked failed. Observed on run 186 (2026-10-27): one domain's
`UPDATE run_domains SET status='running'` hit "database is locked" and the
entire run died.

These tests reproduce that exact failure and pin the new contract: the bad
domain is marked failed, the rest complete, the run finishes normally — and
pause/cancel still propagate.
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
import tempfile

import pytest
from sqlalchemy.exc import OperationalError


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


def _locked() -> OperationalError:
    """The exact error that failed run 186 on 2026-10-27."""
    return OperationalError(
        "UPDATE run_domains SET status=?, started_at=? WHERE run_domains.id = ?",
        {}, sqlite3.OperationalError("database is locked"),
    )


def _make_run(session, domains):
    from app.models import Run, RunDomain
    from app.schemas import AnalyzeSpec, CriteriaSpec

    spec = AnalyzeSpec(domains=domains, criteria=CriteriaSpec(), use_cache=False)
    run = Run(job_id=0, status="pending", spec_json=spec.model_dump_json())
    session.add(run)
    session.flush()
    ids = {}
    for d in domains:
        rd = RunDomain(run_id=run.id, domain=d, status="pending")
        session.add(rd)
        session.flush()
        ids[d] = rd.id
    session.commit()
    return run.id, ids


# What a default CriteriaSpec() enables. The post-run coverage audit
# (`_audit_missing_cr_coverage`) flips a "done" domain to "failed" when it
# has no result for an enabled criterion, so a realistic healthy domain
# must write one per criterion.
DEFAULT_CRITERIA = ("backlinks", "refdomains", "anchors", "keywords")


def _complete(tasks, rd_id):
    """Do what a healthy domain does: begin, write a result per enabled
    criterion, finish."""
    from app.db import SessionLocal
    from app.models import CriterionResult

    tasks._begin_domain(rd_id)
    db = SessionLocal()
    try:
        for c in DEFAULT_CRITERIA:
            db.add(CriterionResult(run_domain_id=rd_id, criterion=c,
                                   status="done", data_json="{}"))
        db.commit()
    finally:
        db.close()
    tasks._finish_domain(rd_id, True)


def _patch_runner(monkeypatch, tasks, fake):
    monkeypatch.setattr(tasks, "_process_domain", fake)
    monkeypatch.setattr(tasks, "schedule_wayback_auto_retry", lambda _rid: None)


def test_one_failing_domain_no_longer_fails_the_run(fresh_db, monkeypatch):
    from app import tasks
    from app.models import Run, RunDomain

    run_id, ids = _make_run(fresh_db, ["a.kz", "b.kz", "bad.kz", "c.kz"])
    bad = ids["bad.kz"]

    async def fake(rd_id, _spec, _run_id):
        if rd_id == bad:
            raise _locked()            # dies at its first write, like run 186
        await asyncio.sleep(0.01)      # siblings are still in flight when it dies
        _complete(tasks, rd_id)

    _patch_runner(monkeypatch, tasks, fake)
    asyncio.run(tasks.process_run(run_id))

    fresh_db.expire_all()
    run = fresh_db.get(Run, run_id)
    assert run.status == "done", (run.status, run.error)
    for d in ("a.kz", "b.kz", "c.kz"):
        assert fresh_db.get(RunDomain, ids[d]).status == "done", d
    rd_bad = fresh_db.get(RunDomain, bad)
    assert rd_bad.status == "failed"
    assert "database is locked" in rd_bad.error
    assert rd_bad.finished_at is not None


def test_cancellation_is_not_swallowed(fresh_db, monkeypatch):
    """The main risk of the change. CancelledError is a BaseException, so
    `except Exception` must let pause/cancel through untouched — and must
    not misrecord a cancellation as a domain failure. Guards against anyone
    widening the handler to `except BaseException`."""
    from app import tasks
    from app.models import RunDomain

    run_id, ids = _make_run(fresh_db, ["x.kz"])

    async def fake(_rd_id, _spec, _run_id):
        raise asyncio.CancelledError()

    _patch_runner(monkeypatch, tasks, fake)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(tasks.process_run(run_id))

    fresh_db.expire_all()
    assert fresh_db.get(RunDomain, ids["x.kz"]).status != "failed"


def test_fail_domain_never_overwrites_a_terminal_state(fresh_db):
    """A domain that already finished keeps its state — above all, a
    user's 'canceled' is never turned into 'failed'."""
    from app import tasks
    from app.models import RunDomain

    _run_id, ids = _make_run(fresh_db, ["done.kz", "canceled.kz", "running.kz"])
    for d, st in (("done.kz", "done"), ("canceled.kz", "canceled"),
                  ("running.kz", "running")):
        fresh_db.get(RunDomain, ids[d]).status = st
    fresh_db.commit()

    for rd_id in ids.values():
        tasks._fail_domain(rd_id, "boom")

    fresh_db.expire_all()
    assert fresh_db.get(RunDomain, ids["done.kz"]).status == "done"
    assert fresh_db.get(RunDomain, ids["canceled.kz"]).status == "canceled"
    r = fresh_db.get(RunDomain, ids["running.kz"])
    assert r.status == "failed" and r.error == "boom"


def test_run_where_every_domain_fails_is_not_misreported(fresh_db, monkeypatch):
    """If every domain fails at its first write, none had `started_at` set,
    and the run would have been diagnosed as a stale Cancel/Pause flag.
    `_fail_domain` stamps `started_at`, so the diagnosis stays honest."""
    from app import tasks
    from app.models import Run, RunDomain

    run_id, ids = _make_run(fresh_db, ["p.kz", "q.kz"])

    async def fake(_rd_id, _spec, _run_id):
        raise _locked()

    _patch_runner(monkeypatch, tasks, fake)
    asyncio.run(tasks.process_run(run_id))

    fresh_db.expire_all()
    run = fresh_db.get(Run, run_id)
    assert "stale Cancel" not in (run.error or ""), run.error
    # Pinned so the behaviour is explicit: the run completes, and every
    # failure is visible per-row and retryable via "Retry failed".
    assert run.status == "done"
    for rd_id in ids.values():
        rd = fresh_db.get(RunDomain, rd_id)
        assert rd.status == "failed" and rd.started_at is not None


def test_long_errors_are_truncated(fresh_db):
    from app import tasks
    from app.models import RunDomain

    _run_id, ids = _make_run(fresh_db, ["long.kz"])
    tasks._fail_domain(ids["long.kz"], "x" * 10_000)
    fresh_db.expire_all()
    assert len(fresh_db.get(RunDomain, ids["long.kz"]).error) == 2000
