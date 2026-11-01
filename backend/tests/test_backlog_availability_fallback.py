"""Backlog availability falls back to Availability run results (2026-11-01).

The Backlog's Availability column and filter read the check history, which
the daily retention prune trims. A trimmed domain read as "never checked"
although its run result (never pruned) still had the verdict. When a domain
has NO history row at all, the run results now supply its status, with the
history's own rule: newest definitive verdict first, else newest of any.
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


T0 = datetime(2026, 10, 1)


def _seed(db):
    from app.models import (AvailabilityCheck, BacklogDomain, CriterionResult,
                            Job, Run, RunDomain)
    runs = []
    for day in (1, 2):
        job = Job(name=f"av{day}", notes="", spec_json="{}", kind="availability")
        db.add(job)
        db.flush()
        run = Run(job_id=job.id, status="done", spec_json="{}", error="")
        db.add(run)
        db.flush()
        runs.append(run)

    def run_verdict(day, domain, status=None, raw=None):
        rd = RunDomain(run_id=runs[day - 1].id, domain=domain, status="done", error="",
                       finished_at=T0 + timedelta(days=day))
        db.add(rd)
        db.flush()
        data = raw if raw is not None else json.dumps(
            {"verdict": {"status": status, "provider": "rdap",
                         "registrar": "Reg LLC", "expires_on": "2027-05-08"}})
        db.add(CriterionResult(run_domain_id=rd.id, criterion="availability",
                               status="done", request_url="", error="", data_json=data))

    def history(domain, status):
        db.add(AvailabilityCheck(domain=domain, provider="rdap", status=status,
                                 checked_at=T0 + timedelta(days=5), registrar="",
                                 error_message="", error_category="", raw_response=""))

    run_verdict(1, "hist.kz", "available")             # history exists: history wins
    history("hist.kz", "registered")
    run_verdict(1, "pruned-taken.kz", "registered")    # history trimmed: run says taken
    run_verdict(1, "pruned-free.kz", "registered")     # newer run says available
    run_verdict(2, "pruned-free.kz", "available")
    run_verdict(1, "pruned-unknown.kz", "unknown")     # only an inconclusive run verdict
    run_verdict(1, "pruned-mixed.kz", "registered")    # definitive beats newer unknown
    run_verdict(2, "pruned-mixed.kz", "unknown")
    run_verdict(1, "badjson.kz", raw="{not json")      # unusable -> never checked
    history("hist-unknown.kz", "unknown")              # history first, even if inconclusive
    run_verdict(1, "hist-unknown.kz", "registered")
    for d in ("hist.kz", "pruned-taken.kz", "pruned-free.kz", "pruned-unknown.kz",
              "pruned-mixed.kz", "badjson.kz", "hist-unknown.kz", "never.kz"):
        db.add(BacklogDomain(domain=d, registrar="src"))
    db.commit()


def _client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)


def _filtered(client, statuses):
    r = client.get(f"/backlog?per_page=100&availability={statuses}")
    assert r.status_code == 200, r.text
    return sorted(row["domain"] for row in r.json()["rows"])


def test_filter_buckets_with_fallback(fresh_db):
    _seed(fresh_db)
    c = _client()
    assert _filtered(c, "registered") == ["hist.kz", "pruned-mixed.kz", "pruned-taken.kz"]
    assert _filtered(c, "available") == ["pruned-free.kz"]
    assert _filtered(c, "unknown") == ["hist-unknown.kz", "pruned-unknown.kz"]
    assert _filtered(c, "__none__") == ["badjson.kz", "never.kz"]
    assert _filtered(c, "registered,__none__") == [
        "badjson.kz", "hist.kz", "never.kz", "pruned-mixed.kz", "pruned-taken.kz"]


def test_column_shows_definitive_run_verdict_when_history_is_gone(fresh_db):
    _seed(fresh_db)
    r = _client().post("/availability/latest", json={"domains": [
        "hist.kz", "pruned-taken.kz", "pruned-free.kz", "pruned-unknown.kz",
        "pruned-mixed.kz", "badjson.kz", "never.kz"]})
    assert r.status_code == 200, r.text
    got = {row["domain"]: row for row in r.json()}
    assert {d: row["status"] for d, row in got.items()} == {
        "hist.kz": "registered",            # from history
        "pruned-taken.kz": "registered",    # from the run result
        "pruned-free.kz": "available",      # newest definitive run verdict
        "pruned-mixed.kz": "registered",    # definitive beats the newer unknown
    }                                       # unknown / unusable / never: no row, as before
    taken = got["pruned-taken.kz"]
    assert taken["registrar"] == "Reg LLC" and taken["expires_on"] == "2027-05-08"
    assert taken["checked_at"].startswith("2026-10-02")


def test_delete_all_filtered_registered_now_catches_trimmed_domains(fresh_db):
    """The operator's goal: Backlog -> filter registered -> Delete all
    filtered removes taken domains even after their history was trimmed."""
    from app.models import BacklogDomain
    _seed(fresh_db)
    r = _client().post("/backlog/bulk-delete-filtered", json={"availability": "registered"})
    assert r.status_code == 200, r.text
    fresh_db.expire_all()
    left = sorted(d for (d,) in fresh_db.query(BacklogDomain.domain))
    assert left == ["badjson.kz", "hist-unknown.kz", "never.kz",
                    "pruned-free.kz", "pruned-unknown.kz"]
