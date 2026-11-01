"""The Database snapshot skips availability-only taken domains (2026-11-01).

They used to be built into every snapshot and then hidden by the "show
taken" rule (on the VPS, most of ~100k domains). The SQL pre-filter is
deliberately conservative; the invariant pinned here: the visible page is
IDENTICAL with and without it, and it only ever drops domains the old
rule already hid.
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
        db_mod.engine.dispose()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def _verdict(status):
    return json.dumps({"verdict": {"status": status, "provider": "rdap"}, "trace": []})


def _seed(db):
    from app.models import (CriterionResult, DomainNote, Job, JobCriterionPin,
                            Run, RunDomain)
    t0 = datetime(2026, 10, 1)

    def run(kind, day):
        job = Job(name=kind, notes="", spec_json="{}", kind=kind)
        db.add(job)
        db.flush()
        r = Run(job_id=job.id, status="done", spec_json="{}", error="",
                started_at=t0 + timedelta(days=day), finished_at=t0 + timedelta(days=day))
        db.add(r)
        db.flush()
        return job, r

    _, av1 = run("availability", 1)
    _, av2 = run("availability", 2)
    pinned_job, av_pinned = run("availability", 3)
    _, quality = run("quality", 4)
    db.add(JobCriterionPin(job_id=pinned_job.id, criterion="availability", run_id=av_pinned.id))

    def check(run_, domain, data, crit="availability", status="done"):
        rd = RunDomain(run_id=run_.id, domain=domain, status="done", error="",
                       finished_at=run_.finished_at)
        db.add(rd)
        db.flush()
        db.add(CriterionResult(run_domain_id=rd.id, criterion=crit, status=status,
                               request_url="", error="", data_json=data))

    check(av1, "taken.kz", _verdict("registered"))                 # excluded
    check(av1, "unknown.kz", _verdict("unknown"))                  # excluded
    check(av1, "error.kz", _verdict("error"))                      # excluded
    check(av1, "free.kz", _verdict("available"))                   # shown
    check(av1, "noted.kz", _verdict("registered"))                 # note -> shown
    db.add(DomainNote(domain="noted.kz", note="watch this one"))
    check(av1, "mixed.kz", _verdict("available"))                  # any available -> loaded
    check(av2, "mixed.kz", _verdict("registered"))
    check(av1, "retaken.kz", _verdict("registered"))               # failed retry ignored
    check(av2, "retaken.kz", "", status="failed")
    check(av_pinned, "pinned.kz", _verdict("registered"))          # pinned run -> loaded
    check(av1, "both.kz", _verdict("registered"))                  # also Quality -> shown
    check(quality, "both.kz", json.dumps({"wayback": [{"timestamp": "2020"}]}), crit="wayback")
    check(av1, "badjson.kz", "{not json")                          # unusable -> loaded
    check(av1, "noverdict.kz", json.dumps({"trace": []}))          # unusable -> loaded
    db.commit()


def _build(db):
    from app.routers.database import _build_all_rows
    rows, _opts, hide = _build_all_rows(db)
    return {r.domain: r for r in rows}, hide


def test_visible_page_is_identical_and_only_hidden_domains_are_skipped(
    fresh_db, monkeypatch,
):
    from sqlalchemy import false, select
    from app.models import RunDomain
    from app.routers import database as dbr
    _seed(fresh_db)

    new_rows, new_hide = _build(fresh_db)
    monkeypatch.setattr(dbr, "_taken_availability_only_domains",
                        lambda: select(RunDomain.domain).where(false()))
    old_rows, old_hide = _build(fresh_db)

    skipped = set(old_rows) - set(new_rows)
    assert skipped == {"taken.kz", "unknown.kz", "error.kz", "retaken.kz"}
    assert skipped <= old_hide                       # only ever what was hidden
    assert set(new_rows) <= set(old_rows)
    old_visible = {d: r for d, r in old_rows.items() if d not in old_hide}
    new_visible = {d: r for d, r in new_rows.items() if d not in new_hide}
    assert set(new_visible) == set(old_visible)
    for d in old_visible:                            # row-for-row identical
        assert new_visible[d].model_dump() == old_visible[d].model_dump(), d
    assert {"free.kz", "noted.kz"} <= set(new_visible)
    # Its Quality run isn't pinned, so the old rule hid it too — but it has
    # a Quality check, so the SQL filter still loads it and the in-loop
    # rule decides, exactly as before.
    assert "both.kz" in new_rows and "both.kz" in new_hide and "both.kz" in old_hide


def test_a_patch_never_brings_a_skipped_domain_back(fresh_db):
    from app.routers.database import _build_all_rows
    _seed(fresh_db)
    rows, _opts, _hide = _build_all_rows(fresh_db, only_domains={"taken.kz", "free.kz"})
    assert [r.domain for r in rows] == ["free.kz"]


def test_adding_a_note_brings_a_taken_domain_back(fresh_db):
    """A noted domain is one the operator cares about, as before."""
    from app.models import DomainNote
    _seed(fresh_db)
    rows, _hide = _build(fresh_db)
    assert "taken.kz" not in rows
    fresh_db.add(DomainNote(domain="taken.kz", note="keep"))
    fresh_db.commit()
    rows, hide = _build(fresh_db)
    assert "taken.kz" in rows and "taken.kz" not in hide
